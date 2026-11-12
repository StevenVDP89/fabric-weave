# %%
import importlib.util
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from pyspark.sql import types as T


_SHARED_PATH = "/lakehouse/default/Files/config/notebook_shared.py"
_shared_spec = importlib.util.spec_from_file_location("ai_readiness_shared", _SHARED_PATH)
shared = importlib.util.module_from_spec(_shared_spec)
_shared_spec.loader.exec_module(shared)

RUN_STATE_PATH = "/lakehouse/default/Files/system/ai_readiness/current_run.json"
RUN_STATUS_PATH = shared.RUN_STATUS_PATH
STAGE = "usage"
PBI_BASE = "https://api.powerbi.com/v1.0/myorg"
WINDOW_DAYS = 28

USAGE_SCHEMA = T.StructType(
    [
        T.StructField("model_id", T.StringType(), False),
        T.StructField("workspace_id", T.StringType(), False),
        T.StructField("window_days", T.IntegerType(), False),
        T.StructField("distinct_users", T.IntegerType(), True),
        T.StructField("view_events", T.IntegerType(), True),
        T.StructField("external_connect_events", T.IntegerType(), True),
        T.StructField("last_activity_utc", T.TimestampType(), True),
        T.StructField("usage_tier", T.StringType(), True),
        T.StructField("collected_utc", T.TimestampType(), True),
        T.StructField("copilot_events", T.IntegerType(), True),
        T.StructField("run_id", T.StringType(), True),
    ]
)

SCAN_RUNS_SCHEMA = T.StructType(
    [
        T.StructField("run_id", T.StringType(), False),
        T.StructField("started_utc", T.TimestampType(), True),
        T.StructField("finished_utc", T.TimestampType(), True),
        T.StructField("status", T.StringType(), True),
        T.StructField("workspaces_scanned", T.IntegerType(), True),
        T.StructField("models_found", T.IntegerType(), True),
        T.StructField("notes", T.StringType(), True),
    ]
)

VIEW_ACTIVITIES = {"ViewReport", "ExportReport"}
EXTERNAL_ACTIVITIES = {"AnalyzeInExcel", "ConnectFromExternalApplication"}
COPILOT_RE = re.compile(r"copilot", re.I)


# %%
def _pbi_token():
    return shared.get_token("pbi", "https://analysis.windows.net/powerbi/api")


def _quoted(value):
    return quote("'" + value + "'", safe="")


def _api_time(value):
    if value is None:
        return None
    return shared.isoformat_z(value.replace(microsecond=0))


def _to_ts(value):
    parsed = shared.parse_timestamp(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _usage_tier(view_events, external_events, copilot_events, distinct_users):
    total = int(view_events or 0) + int(external_events or 0) + int(copilot_events or 0)
    users = int(distinct_users or 0)
    if total == 0 and users == 0:
        return "Unused"
    if total >= 50 or users >= 10:
        return "High"
    if total >= 10 or users >= 3:
        return "Medium"
    return "Low"


def _iter_activity_events(token, start_iso, end_iso):
    url = (
        f"{PBI_BASE}/admin/activityevents"
        f"?startDateTime={_quoted(start_iso)}"
        f"&endDateTime={_quoted(end_iso)}"
    )
    while url:
        _, _, payload = shared.http_json("GET", url, token=token)
        for row in payload.get("activityEventEntities", []) or []:
            yield row
        continuation_url = payload.get("continuationUri")
        continuation = payload.get("continuationToken")
        if continuation_url:
            url = continuation_url
        elif continuation:
            url = f"{PBI_BASE}/admin/activityevents?continuationToken={quote(continuation, safe='')}"
        else:
            url = None


def _load_models():
    rows = spark.table("model_inventory").select("model_id", "workspace_id").collect()
    return [{"model_id": row["model_id"], "workspace_id": row["workspace_id"]} for row in rows]


# %%
run_id = None
started_utc = None

try:
    state = shared.read_json(RUN_STATE_PATH)
    run_id = state.get("run_id")
    started_utc = shared.to_naive_utc(state.get("started_utc"))
    collected_utc = shared.utcnow().replace(tzinfo=None)

    if not run_id:
        raise RuntimeError("NB_02_Usage could not find the current run state from NB_01_Scan_Inventory.")

    shared.write_run_status(run_id, "Running", STAGE, started_utc)

    models = _load_models()
    usage_map = {
        (row["workspace_id"], row["model_id"]): {
            "users": set(),
            "view_events": 0,
            "external_connect_events": 0,
            "copilot_events": 0,
            "last_activity_utc": None,
        }
        for row in models
    }

    # Any failure while reading activity events fails the notebook: zero usage would be indistinguishable
    # from real "unused" models, and model_usage is only replaced once the whole window has been read.
    token = _pbi_token()
    now = shared.utcnow()
    window_start = now - timedelta(days=WINDOW_DAYS - 1)
    for day_offset in range(WINDOW_DAYS):
        day = (window_start + timedelta(days=day_offset)).date()
        start_dt = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
        end_dt = datetime.combine(day, datetime.max.time(), tzinfo=timezone.utc).replace(microsecond=0)
        if end_dt > now:
            end_dt = now.replace(microsecond=0)
        shared.log(f"Reading activity events for {start_dt.date().isoformat()}.")
        for event in _iter_activity_events(token, _api_time(start_dt), _api_time(end_dt)):
            dataset_id = event.get("DatasetId")
            workspace_id = event.get("WorkspaceId")
            if not dataset_id or not workspace_id:
                continue
            key = (workspace_id, dataset_id)
            if key not in usage_map:
                continue
            activity = (event.get("Activity") or event.get("Operation") or "").strip()
            created = _to_ts(event.get("CreationTime"))
            bucket = usage_map[key]
            is_relevant = False
            if activity in VIEW_ACTIVITIES:
                bucket["view_events"] += 1
                is_relevant = True
            if activity in EXTERNAL_ACTIVITIES:
                bucket["external_connect_events"] += 1
                is_relevant = True
            if COPILOT_RE.search(activity):
                bucket["copilot_events"] += 1
                is_relevant = True
            if not is_relevant:
                continue
            user_id = event.get("UserId")
            if user_id:
                bucket["users"].add(user_id)
            if created and (bucket["last_activity_utc"] is None or created > bucket["last_activity_utc"]):
                bucket["last_activity_utc"] = created

    usage_rows = []
    for model in models:
        key = (model["workspace_id"], model["model_id"])
        bucket = usage_map[key]
        distinct_users = len(bucket["users"])
        usage_rows.append(
            {
                "model_id": model["model_id"],
                "workspace_id": model["workspace_id"],
                "window_days": WINDOW_DAYS,
                "distinct_users": distinct_users,
                "view_events": bucket["view_events"],
                "external_connect_events": bucket["external_connect_events"],
                "last_activity_utc": bucket["last_activity_utc"],
                "usage_tier": _usage_tier(
                    bucket["view_events"], bucket["external_connect_events"], bucket["copilot_events"], distinct_users
                ),
                "collected_utc": collected_utc,
                "copilot_events": bucket["copilot_events"],
                "run_id": run_id,
            }
        )

    shared.overwrite_table(spark, "model_usage", usage_rows, USAGE_SCHEMA)

    existing_runs = spark.table("scan_runs").where(f"run_id = '{run_id}'").collect()
    run_row = existing_runs[0].asDict() if existing_runs else {}
    shared.merge_table(
        spark,
        "scan_runs",
        [
            {
                "run_id": run_id,
                "started_utc": started_utc,
                "finished_utc": None,
                "status": "UsageCompleted",
                "workspaces_scanned": run_row.get("workspaces_scanned"),
                "models_found": run_row.get("models_found"),
                "notes": shared.append_note(run_row.get("notes"), "usage_source=admin-activity-events"),
            }
        ],
        SCAN_RUNS_SCHEMA,
        ["run_id"],
    )

    shared.log(f"Usage refresh completed for {len(usage_rows)} model rows.")
except Exception as exc:
    shared.record_failure(spark, run_id, started_utc, STAGE, exc, SCAN_RUNS_SCHEMA, RUN_STATUS_PATH)
    raise
