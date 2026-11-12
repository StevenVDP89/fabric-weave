# %%
import importlib.util
import json
import math
import os
import time
import uuid
from datetime import datetime, timezone

from pyspark.sql import types as T


_SHARED_PATH = "/lakehouse/default/Files/config/notebook_shared.py"
_shared_spec = importlib.util.spec_from_file_location("ai_readiness_shared", _SHARED_PATH)
shared = importlib.util.module_from_spec(_shared_spec)
_shared_spec.loader.exec_module(shared)

WORKSPACE_ID = "{{WORKSPACE_ID}}"
LAKEHOUSE_ID = "{{LAKEHOUSE_ID}}"
LAKEHOUSE_NAME = "{{LAKEHOUSE_NAME}}"
SYSTEM_ROOT = "/lakehouse/default/Files/system/ai_readiness"
RUN_STATE_PATH = f"{SYSTEM_ROOT}/current_run.json"
RUN_STATUS_PATH = shared.RUN_STATUS_PATH
SCAN_DIR_ROOT = f"{SYSTEM_ROOT}/scans"
STAGE = "scan"

# A run whose inventory is under half the size of the previous one fails instead of replacing the last good data.
# To accept such a drop deliberately, set this to "true" (or define an ALLOW_SHRINK=true environment variable).
ALLOW_SHRINK = ""

PBI_BASE = "https://api.powerbi.com/v1.0/myorg"

SETTINGS_HINT = (
    "Check that the tenant settings for the Power BI admin APIs (service principals/admin APIs), "
    "'Enhance admin API responses with detailed metadata' and DAX/mashup expression metadata are enabled."
)


MODEL_INVENTORY_SCHEMA = T.StructType(
    [
        T.StructField("workspace_id", T.StringType(), False),
        T.StructField("workspace_name", T.StringType(), True),
        T.StructField("capacity_id", T.StringType(), True),
        T.StructField("on_dedicated_capacity", T.BooleanType(), True),
        T.StructField("model_id", T.StringType(), False),
        T.StructField("model_name", T.StringType(), True),
        T.StructField("configured_by", T.StringType(), True),
        T.StructField("created_date", T.TimestampType(), True),
        T.StructField("endorsement", T.StringType(), True),
        T.StructField("is_refreshable", T.BooleanType(), True),
        T.StructField("last_refresh_utc", T.TimestampType(), True),
        T.StructField("last_refresh_status", T.StringType(), True),
        T.StructField("storage_mode", T.StringType(), True),
        T.StructField("table_count", T.IntegerType(), True),
        T.StructField("column_count", T.IntegerType(), True),
        T.StructField("measure_count", T.IntegerType(), True),
        T.StructField("relationship_count", T.IntegerType(), True),
        T.StructField("described_object_pct", T.DoubleType(), True),
        T.StructField("sensitivity_label", T.StringType(), True),
        T.StructField("report_count", T.IntegerType(), True),
        T.StructField("scan_utc", T.TimestampType(), True),
    ]
)

MODEL_SCAN_DETAIL_SCHEMA = T.StructType(
    [
        T.StructField("run_id", T.StringType(), False),
        T.StructField("workspace_id", T.StringType(), False),
        T.StructField("workspace_name", T.StringType(), True),
        T.StructField("model_id", T.StringType(), False),
        T.StructField("model_name", T.StringType(), True),
        T.StructField("scan_mode", T.StringType(), True),
        T.StructField("dataset_json", T.StringType(), True),
        T.StructField("scan_utc", T.TimestampType(), True),
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


# %%
def _pbi_token():
    return shared.get_token("pbi", "https://analysis.windows.net/powerbi/api")


# Per-model enrichment calls are best effort; they are counted so the run notes show when they degraded.
_ENRICHMENT_FAILURES = {"details": 0, "refresh": 0}


def _to_ts(value):
    parsed = shared.parse_timestamp(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _pct_described(dataset):
    visible_tables = 0
    described = 0
    for table in dataset.get("tables", []) or []:
        if table.get("isHidden"):
            continue
        visible_tables += 1
        if str(table.get("description") or "").strip():
            described += 1
        for column in table.get("columns", []) or []:
            if column.get("isHidden"):
                continue
            visible_tables += 1
            if str(column.get("description") or "").strip():
                described += 1
        for measure in table.get("measures", []) or []:
            if measure.get("isHidden"):
                continue
            visible_tables += 1
            if str(measure.get("description") or "").strip():
                described += 1
    if visible_tables == 0:
        return None
    return described / float(visible_tables)


def _report_count(workspace, dataset_id):
    count = 0
    for report in workspace.get("reports", []) or []:
        if report.get("datasetId") == dataset_id:
            count += 1
    return count


def _storage_mode(dataset):
    return dataset.get("targetStorageMode") or next(
        (
            table.get("storageMode")
            for table in dataset.get("tables", []) or []
            if table.get("storageMode")
        ),
        None,
    )


def _endorsement(dataset):
    details = dataset.get("endorsementDetails") or {}
    return details.get("endorsement") if isinstance(details, dict) else None


def _sensitivity_label(dataset):
    label = dataset.get("sensitivityLabel") or {}
    if isinstance(label, dict):
        return label.get("labelId") or label.get("id")
    return None


def _dataset_counts(dataset):
    tables = dataset.get("tables", []) or []
    table_count = len(tables)
    column_count = sum(len(table.get("columns", []) or []) for table in tables)
    measure_count = sum(len(table.get("measures", []) or []) for table in tables)
    relationships = dataset.get("relationships")
    relationship_count = len(relationships) if isinstance(relationships, list) else None
    return table_count, column_count, measure_count, relationship_count


def _get_group_dataset_details(workspace_id, dataset_id, token):
    url = f"{PBI_BASE}/groups/{workspace_id}/datasets/{dataset_id}"
    try:
        _, _, payload = shared.http_json("GET", url, token=token)
        return payload if isinstance(payload, dict) else {}
    except Exception as exc:
        _ENRICHMENT_FAILURES["details"] += 1
        shared.log(f"Dataset details unavailable for {dataset_id}: {shared.redact_error(exc, 300)}")
        return {}


def _get_last_refresh(workspace_id, dataset_id, token):
    """Returns (end time, status) of the latest refresh as reported by the refresh history, or (None, None)."""
    url = f"{PBI_BASE}/groups/{workspace_id}/datasets/{dataset_id}/refreshes?$top=1"
    try:
        _, _, payload = shared.http_json("GET", url, token=token)
        rows = payload.get("value", []) if isinstance(payload, dict) else []
        if not rows:
            return None, None
        refresh = rows[0]
        return _to_ts(refresh.get("endTime") or refresh.get("startTime")), refresh.get("status")
    except Exception as exc:
        _ENRICHMENT_FAILURES["refresh"] += 1
        shared.log(f"Refresh history unavailable for {dataset_id}: {shared.redact_error(exc, 300)}")
        return None, None


def _admin_scan():
    token = _pbi_token()
    modified_url = (
        f"{PBI_BASE}/admin/workspaces/modified"
        "?excludePersonalWorkspaces=true&excludeInActiveWorkspaces=true"
    )
    _, _, workspaces_response = shared.http_json("GET", modified_url, token=token)
    workspace_ids = [row.get("id") for row in (workspaces_response if isinstance(workspaces_response, list) else []) if row.get("id")]
    shared.log(f"Scanner returned {len(workspace_ids)} workspace ids.")

    scan_results = []
    for offset in range(0, len(workspace_ids), 100):
        batch = workspace_ids[offset : offset + 100]
        shared.log(f"Scanning workspace batch {offset + 1}-{offset + len(batch)}.")
        start_url = (
            f"{PBI_BASE}/admin/workspaces/getInfo"
            "?lineage=true&datasourceDetails=true&datasetSchema=true&datasetExpressions=true"
        )
        _, _, scan = shared.http_json("POST", start_url, token=token, json_body={"workspaces": batch}, expected_status={200, 202})
        scan_id = scan.get("id")
        if not scan_id:
            raise RuntimeError(f"Scanner response did not include an id for batch starting at {offset}.")
        status_url = f"{PBI_BASE}/admin/workspaces/scanStatus/{scan_id}"
        status = None
        for _ in range(120):
            _, _, status_body = shared.http_json("GET", status_url, token=token)
            status = status_body.get("status")
            if status == "Succeeded":
                break
            if status in ("Failed", "Cancelled"):
                raise RuntimeError(f"Scanner batch {scan_id} ended with status {status}: {json.dumps(status_body)}")
            time.sleep(5)
        if status != "Succeeded":
            raise TimeoutError(f"Scanner batch {scan_id} did not finish in time.")
        result_url = f"{PBI_BASE}/admin/workspaces/scanResult/{scan_id}"
        _, _, result = shared.http_json("GET", result_url, token=token)
        scan_results.extend(result.get("workspaces", []) or [])
    return {
        "mode": "admin-scanner",
        "workspaces": scan_results,
    }


# %%
run_id = f"scan-{shared.utcnow().strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
started_utc = shared.utcnow().replace(tzinfo=None)
scan_utc = shared.utcnow().replace(tzinfo=None)
allow_shrink = shared.truthy(ALLOW_SHRINK) or shared.truthy(os.environ.get("ALLOW_SHRINK"))

try:
    shared.write_run_status(run_id, "Running", STAGE, started_utc)
    shared.ensure_local_dir(SCAN_DIR_ROOT)

    scan_runs_row = {
        "run_id": run_id,
        "started_utc": started_utc,
        "finished_utc": None,
        "status": "Running",
        "workspaces_scanned": 0,
        "models_found": 0,
        "notes": None,
    }
    shared.merge_table(spark, "scan_runs", [scan_runs_row], SCAN_RUNS_SCHEMA, ["run_id"])

    # There is deliberately no fallback: a partial view of the tenant would overwrite the last good inventory.
    try:
        scan_payload = _admin_scan()
    except Exception as admin_exc:
        raise RuntimeError(f"The tenant admin scan failed: {shared.redact_error(admin_exc, 160)} {SETTINGS_HINT} The previous data was kept.") from admin_exc

    mode = scan_payload["mode"]
    # User lists (emails) are not needed anywhere downstream, so they are dropped before anything is stored.
    scanned_workspaces = shared.strip_user_lists(scan_payload["workspaces"])
    shared.log(f"Scan mode: {mode}. Workspaces returned: {len(scanned_workspaces)}")

    metadata_problem = shared.scan_metadata_problem(scanned_workspaces)
    if metadata_problem:
        raise RuntimeError(f"{metadata_problem} {SETTINGS_HINT} The previous data was kept.")

    pbi_token = _pbi_token()
    inventory_rows = []
    detail_rows = []

    for workspace in scanned_workspaces:
        workspace_id = workspace.get("id")
        workspace_name = workspace.get("name") or workspace.get("displayName")
        if not workspace_id:
            continue
        for dataset in workspace.get("datasets", []) or []:
            dataset_id = dataset.get("id")
            if not dataset_id:
                continue
            table_count, column_count, measure_count, relationship_count = _dataset_counts(dataset)
            details = _get_group_dataset_details(workspace_id, dataset_id, pbi_token)
            last_refresh, last_refresh_status = _get_last_refresh(workspace_id, dataset_id, pbi_token)
            inventory_rows.append(
                {
                    "workspace_id": workspace_id,
                    "workspace_name": workspace_name,
                    "capacity_id": workspace.get("capacityId"),
                    "on_dedicated_capacity": workspace.get("isOnDedicatedCapacity"),
                    "model_id": dataset_id,
                    "model_name": dataset.get("name"),
                    "configured_by": dataset.get("configuredBy") or details.get("configuredBy"),
                    "created_date": _to_ts(dataset.get("createdDate") or details.get("createdDate")),
                    "endorsement": _endorsement(dataset),
                    "is_refreshable": details.get("isRefreshable"),
                    "last_refresh_utc": last_refresh,
                    "last_refresh_status": last_refresh_status,
                    "storage_mode": _storage_mode(dataset) or details.get("targetStorageMode"),
                    "table_count": table_count,
                    "column_count": column_count,
                    "measure_count": measure_count,
                    "relationship_count": relationship_count,
                    "described_object_pct": _pct_described(dataset),
                    "sensitivity_label": _sensitivity_label(dataset),
                    "report_count": _report_count(workspace, dataset_id),
                    "scan_utc": scan_utc,
                }
            )
            detail_rows.append(
                {
                    "run_id": run_id,
                    "workspace_id": workspace_id,
                    "workspace_name": workspace_name,
                    "model_id": dataset_id,
                    "model_name": dataset.get("name"),
                    "scan_mode": mode,
                    "dataset_json": json.dumps(dataset, ensure_ascii=False),
                    "scan_utc": scan_utc,
                }
            )

    # Everything has been collected in memory. Only now are the previous tables compared and replaced.
    previous_count = spark.table("model_inventory").count() if shared.table_exists(spark, "model_inventory") else 0
    shared.check_inventory_shrink(len(inventory_rows), previous_count, allow=allow_shrink)

    scan_folder = f"{SCAN_DIR_ROOT}/{run_id}"
    shared.ensure_local_dir(scan_folder)
    shared.write_json(
        f"{scan_folder}/scan_result.json",
        {
            "run_id": run_id,
            "scan_mode": mode,
            "scan_utc": shared.isoformat_z(scan_utc),
            "workspace_count": len(scanned_workspaces),
            "workspaces": scanned_workspaces,
        },
    )

    shared.overwrite_table(spark, "model_inventory", inventory_rows, MODEL_INVENTORY_SCHEMA)
    shared.overwrite_table(spark, "model_scan_detail", detail_rows, MODEL_SCAN_DETAIL_SCHEMA)

    shared.write_json(
        RUN_STATE_PATH,
        {
            "run_id": run_id,
            "started_utc": shared.isoformat_z(started_utc),
            "scan_utc": shared.isoformat_z(scan_utc),
            "scan_mode": mode,
            "workspace_count": len(scanned_workspaces),
            "model_count": len(detail_rows),
            "lakehouse_id": LAKEHOUSE_ID,
            "lakehouse_name": LAKEHOUSE_NAME,
            "workspace_id": WORKSPACE_ID,
        },
    )

    notes = f"mode={mode}"
    if _ENRICHMENT_FAILURES["details"] or _ENRICHMENT_FAILURES["refresh"]:
        notes = shared.append_note(
            notes,
            f"dataset details unavailable for {_ENRICHMENT_FAILURES['details']} model(s); "
            f"refresh history unavailable for {_ENRICHMENT_FAILURES['refresh']} model(s)",
        )

    shared.merge_table(
        spark,
        "scan_runs",
        [
            {
                "run_id": run_id,
                "started_utc": started_utc,
                "finished_utc": None,
                "status": "InventoryCompleted",
                "workspaces_scanned": len(scanned_workspaces),
                "models_found": len(detail_rows),
                "notes": notes,
            }
        ],
        SCAN_RUNS_SCHEMA,
        ["run_id"],
    )

    shared.log(f"Inventory refresh completed. Models found: {len(detail_rows)}")
except Exception as exc:
    shared.record_failure(spark, run_id, started_utc, STAGE, exc, SCAN_RUNS_SCHEMA, RUN_STATUS_PATH)
    raise
