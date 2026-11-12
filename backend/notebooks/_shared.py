import json
import math
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone


def utcnow():
    return datetime.now(timezone.utc)


def isoformat_z(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(str(value), fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return None


def safe_json_loads(text, default=None):
    if text in (None, ""):
        return {} if default is None else default
    try:
        return json.loads(text)
    except Exception:
        return {} if default is None else default


def log(message):
    print(f"[{utcnow().strftime('%Y-%m-%d %H:%M:%S')}Z] {message}")


def get_notebookutils():
    try:
        import notebookutils  # type: ignore

        return notebookutils
    except Exception:
        try:
            import mssparkutils  # type: ignore

            return mssparkutils
        except Exception:
            return None


NOTEBOOKUTILS = get_notebookutils()


def get_token(*candidates):
    if NOTEBOOKUTILS is None:
        raise RuntimeError("Notebook credentials utilities are unavailable.")
    credentials = getattr(NOTEBOOKUTILS, "credentials", None)
    if credentials is None:
        raise RuntimeError("Notebook credentials helper is unavailable.")

    errors = []
    for candidate in candidates:
        if not candidate:
            continue
        try:
            token = credentials.getToken(candidate)
            if isinstance(token, dict):
                token = token.get("token") or token.get("accessToken")
            if token:
                return token
        except Exception as exc:
            errors.append(f"{candidate}: {exc}")
    raise RuntimeError(f"Unable to obtain token for any of {candidates}. Details: {' | '.join(errors)}")


def _sleep_seconds(seconds):
    time.sleep(max(0.0, float(seconds)))


def http_request(
    method,
    url,
    token=None,
    json_body=None,
    data=None,
    headers=None,
    expected_status=None,
    retries=6,
    timeout=120,
):
    if expected_status is None:
        expected_status = {200}
    elif isinstance(expected_status, int):
        expected_status = {expected_status}
    else:
        expected_status = set(expected_status)

    payload = data
    req_headers = dict(headers or {})
    if token:
        req_headers["Authorization"] = f"Bearer {token}"
    if json_body is not None:
        payload = json.dumps(json_body).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    elif isinstance(payload, str):
        payload = payload.encode("utf-8")

    attempt = 0
    while True:
        request = urllib.request.Request(url, data=payload, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                text = body.decode("utf-8", errors="replace")
                status = response.getcode()
                response_headers = dict(response.headers.items())
                if status not in expected_status:
                    raise RuntimeError(f"Unexpected HTTP {status} for {url}: {text[:1000]}")
                return status, response_headers, text
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries:
                retry_after = exc.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else min(60.0, 2 ** attempt + random.random())
                log(f"HTTP {exc.code} on {url}; retrying in {wait:.1f}s")
                _sleep_seconds(wait)
                attempt += 1
                continue
            raise RuntimeError(f"HTTP {exc.code} for {url}: {body[:2000]}")
        except Exception:
            if attempt < retries:
                wait = min(60.0, 2 ** attempt + random.random())
                log(f"Request failed for {url}; retrying in {wait:.1f}s")
                _sleep_seconds(wait)
                attempt += 1
                continue
            raise


def http_json(*args, **kwargs):
    status, headers, text = http_request(*args, **kwargs)
    return status, headers, safe_json_loads(text, default={})


def list_with_continuation(url, token, value_key="value"):
    results = []
    next_url = url
    while next_url:
        _, _, body = http_json("GET", next_url, token=token)
        page_values = body.get(value_key) if isinstance(body, dict) else None
        if page_values is None and value_key == "value" and isinstance(body, list):
            page_values = body
        results.extend(page_values or [])
        next_url = body.get("continuationUri") if isinstance(body, dict) else None
    return results


def ensure_local_dir(path):
    os.makedirs(path, exist_ok=True)


def write_text(path, text):
    """Writes atomically: a temp file in the same folder is moved over the target, so readers never see a partial file."""
    ensure_local_dir(os.path.dirname(path) or ".")
    tmp_path = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def write_json(path, obj):
    write_text(path, json.dumps(obj, indent=2, sort_keys=True))


def read_json(path, default=None):
    if not os.path.exists(path):
        return {} if default is None else default
    with open(path, "r", encoding="utf-8") as handle:
        return safe_json_loads(handle.read(), default=default)


def table_exists(spark, name):
    try:
        return bool(spark.catalog.tableExists(name))
    except Exception:
        try:
            spark.table(name)
            return True
        except Exception:
            return False


def dataframe_from_rows(spark, rows, schema):
    if rows:
        return spark.createDataFrame(rows, schema=schema)
    return spark.createDataFrame([], schema=schema)


def overwrite_table(spark, name, rows, schema):
    df = dataframe_from_rows(spark, rows, schema)
    (
        df.write.mode("overwrite")
        .format("delta")
        .option("overwriteSchema", "true")
        .saveAsTable(name)
    )
    return df


def merge_table(spark, name, rows, schema, key_columns):
    df = dataframe_from_rows(spark, rows, schema)
    if not table_exists(spark, name):
        (
            df.write.mode("overwrite")
            .format("delta")
            .option("overwriteSchema", "true")
            .saveAsTable(name)
        )
        return df

    temp_view = f"_merge_{name}_{uuid.uuid4().hex[:8]}"
    df.createOrReplaceTempView(temp_view)
    on_clause = " AND ".join([f"t.{col} = s.{col}" for col in key_columns])
    update_clause = ", ".join([f"{col} = s.{col}" for col in df.columns])
    insert_columns = ", ".join(df.columns)
    insert_values = ", ".join([f"s.{col}" for col in df.columns])
    spark.sql(
        f"""
        MERGE INTO {name} AS t
        USING {temp_view} AS s
        ON {on_clause}
        WHEN MATCHED THEN UPDATE SET {update_clause}
        WHEN NOT MATCHED THEN INSERT ({insert_columns}) VALUES ({insert_values})
        """
    )
    spark.catalog.dropTempView(temp_view)
    return df


def append_note(existing, addition):
    items = [part.strip() for part in [existing, addition] if part and str(part).strip()]
    return "; ".join(items)


ABBREVIATIONS = {
    "qty": "Quantity",
    "amt": "Amount",
    "cust": "Customer",
    "custs": "Customers",
    "nm": "Name",
    "cd": "Code",
    "desc": "Description",
    "descr": "Description",
    "num": "Number",
    "nbr": "Number",
    "nr": "Number",
    "dt": "Date",
    "ts": "Timestamp",
    "prod": "Product",
    "prd": "Product",
    "cat": "Category",
    "ctgry": "Category",
    "cntry": "Country",
    "ctry": "Country",
    "reg": "Region",
    "rgn": "Region",
    "emp": "Employee",
    "mgr": "Manager",
    "dept": "Department",
    "addr": "Address",
    "tel": "Telephone",
    "pct": "Percent",
    "avg": "Average",
    "cnt": "Count",
    "tot": "Total",
    "src": "Source",
    "tgt": "Target",
    "curr": "Currency",
    "cur": "Currency",
    "ord": "Order",
    "inv": "Invoice",
    "pmt": "Payment",
    "sls": "Sales",
    "rev": "Revenue",
    "cst": "Cost",
    "prc": "Price",
    "yr": "Year",
    "mth": "Month",
    "mon": "Month",
    "wk": "Week",
    "qtr": "Quarter",
    "loc": "Location",
    "seq": "Sequence",
    "flg": "Flag",
    "ind": "Indicator",
    "sts": "Status",
    "stat": "Status",
    "typ": "Type",
    "grp": "Group",
    "lvl": "Level",
    "crt": "Created",
    "upd": "Updated",
    "usr": "User",
    "acct": "Account",
    "bal": "Balance",
    "dscnt": "Discount",
    "disc": "Discount",
    "shp": "Shipment",
    "rcv": "Received",
    "vend": "Vendor",
    "supp": "Supplier",
    "whse": "Warehouse",
    "wh": "Warehouse",
    "mkt": "Market",
    "seg": "Segment",
    "chnl": "Channel",
    "chan": "Channel",
    "org": "Organization",
    "ref": "Reference",
    "val": "Value",
    "bu": "Business Unit",
    "mrg": "Margin",
    "gm": "Gross Margin",
    "tbl": "Table",
    "dim": "Dimension",
    "fct": "Fact",
}


KEEP_UPPER = {
    "id",
    "sku",
    "url",
    "kpi",
    "ytd",
    "mtd",
    "qtd",
    "yoy",
    "mom",
    "qoq",
    "vat",
    "gdp",
    "roi",
    "uk",
    "us",
    "eu",
    "ceo",
    "cfo",
    "hr",
    "it",
    "ai",
    "api",
}


TABLE_PREFIX = re.compile(r"^(dim|fact|fct|stg|stage|tbl|vw|v|d|f|lkp|ref|bridge)[_\s-]+", re.I)
TABLE_SUFFIX = re.compile(r"[_\s-]+(dim|fact|fct|tbl|table|vw|view|lkp|stg)$", re.I)


def tokenize(name):
    if not name:
        return []
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(name))
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return [part for part in re.split(r"[\s_\-.]+", spaced) if part]


def is_technical_table_name(name):
    if TABLE_PREFIX.search(name or "") or TABLE_SUFFIX.search(name or ""):
        return True
    if "_" in str(name):
        return True
    if " " not in str(name) and re.search(r"[a-z][A-Z]", str(name)):
        return True
    compact = str(name or "")
    if re.fullmatch(r"[a-z0-9]+", compact) and len(compact) > 3 and len(tokenize(compact)) == 1 and re.search(r"(tbl|dim|fact)$", compact):
        return True
    return False


def is_technical_name(name):
    text = str(name or "")
    lower = text.lower()
    if "_" in text:
        return True
    if " " not in text and re.search(r"[a-z][A-Z]", text):
        return True
    if re.fullmatch(r"[a-z]+\d*", text) and lower in ABBREVIATIONS:
        return True
    if re.fullmatch(r"[A-Z0-9]{2,}", text) and lower not in KEEP_UPPER and lower in ABBREVIATIONS:
        return True
    if re.fullmatch(r"[a-z0-9]+", text) and len(text) > 2 and " " not in text and re.search(r"\d", text):
        return True
    return False


def abbreviations_in(name):
    found = []
    for token in tokenize(name):
        lower = token.lower()
        if lower in ABBREVIATIONS and lower not in KEEP_UPPER:
            found.append(lower)
    return found


def is_friendly_name(name):
    text = str(name or "")
    return bool(text.strip()) and not is_technical_name(text)


def is_key_like_name(name):
    text = str(name or "").strip()
    if re.fullmatch(r"(id|key|sk|pk|fk|guid|uuid)", text, re.I):
        return True
    if re.search(r"[_\s-](id|key|sk|pk|fk|guid|uuid)$", text, re.I):
        return True
    if re.search(r"[a-z](ID|Id|Key|SK|Guid)$", text):
        return True
    if re.match(r"^(id|sk|pk|fk)[_-]", text, re.I):
        return True
    return False


# ---------------------------------------------------------------------------
# Description quality. Mirrors app/packages/engine/src/rules.ts (the source of truth);
# backend/tests/test_parity.py keeps the two in step.
# ---------------------------------------------------------------------------

DUPLICATE_DESCRIPTION_LIMIT = 5

# Whole-text placeholders: the description is nothing but one of these (punctuation ignored).
PLACEHOLDER_TEXTS = frozenset(
    {
        "tbd", "tba", "tbc", "todo", "to do", "n/a", "na", "none", "nil", "null", "lorem ipsum", "description", "desc",
        "description here", "enter description", "enter description here", "add description", "add description here",
        "your description here", "to be defined", "to be determined", "to be completed", "to be added", "coming soon",
        "placeholder", "test", "testing", "xxx", "x",
    }
)
# Placeholder phrases that make a description uninformative wherever they appear as whole words.
PLACEHOLDER_ANYWHERE = re.compile(
    r"\b(?:tbd|tba|tbc|lorem ipsum|placeholder|coming soon|x{3,}|to be (?:defined|determined|completed|added|filled in|updated|confirmed|decided|written|provided|documented))\b",
    re.I | re.A,
)
PLACEHOLDER_LEADING = re.compile(r"^(?:todo|to do)\b", re.I | re.A)
# Words that carry no information on their own; ignored when checking whether text restates a name.
STOP_WORDS = frozenset(
    {
        "the", "of", "a", "an", "for", "is", "are", "this", "that", "these", "those", "each", "every", "and", "or",
        "in", "on", "to", "by", "with", "per", "all", "its", "it", "as", "from", "column", "field", "table", "measure",
    }
)
_WORD_RE = re.compile(r"[^\W_]+")

DESCRIPTION_PROBLEM_MESSAGE = {
    "short": "Description is too short to be useful.",
    "placeholder": "Description is a placeholder, not real documentation.",
    "restates-name": "Description only restates the name.",
    "duplicate": f"The same description is repeated on {DUPLICATE_DESCRIPTION_LIMIT} or more objects of this kind.",
}


def words_of(text):
    """Lower-cased words of a name or sentence: camelCase, snake_case and spaces all split the same way."""
    words = []
    for token in tokenize(re.sub(r"['\u2019]", "", str(text or ""))):
        words.extend(_WORD_RE.findall(token.lower()))
    return words


def fold_word(word):
    """Folds simple plurals so 'customers' and 'customer' compare equal."""
    if len(word) > 3 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and re.search(r"(?:s|x|z|ch|sh)es$", word):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _content_words(text):
    return [fold_word(word) for word in words_of(text) if word not in STOP_WORDS]


def normalize_description(text):
    """Normalised form used to spot the same boilerplate repeated across objects."""
    return " ".join(_WORD_RE.findall(str(text or "").lower()))


def description_problem(name, description, duplicate_count=1):
    """Why a (non-empty) description is not informative, or None when it is.

    duplicate_count is how many objects of the same kind in the model carry the same normalised text.
    """
    desc = str(description or "").strip()
    if not re.search(r"[^\W_]", desc):
        return "placeholder"
    plain = normalize_description(re.sub(r"n/a", "na", desc, flags=re.I))
    if plain in PLACEHOLDER_TEXTS or PLACEHOLDER_ANYWHERE.search(desc) or PLACEHOLDER_LEADING.search(desc):
        return "placeholder"
    if len(desc) < 15:
        return "short"
    if re.sub(r"[^a-z0-9]", "", desc.lower()) == re.sub(r"[^a-z0-9]", "", str(name or "").lower()):
        return "restates-name"
    if len(desc.split()) < 3:
        return "short"
    content = _content_words(desc)
    if not content:
        return "placeholder"
    name_words = set(_content_words(name))
    if all(word in name_words for word in content):
        return "restates-name"
    if duplicate_count >= DUPLICATE_DESCRIPTION_LIMIT:
        return "duplicate"
    return None


def is_informative_description(name, description, duplicate_count=1):
    return description_problem(name, description, duplicate_count) is None


def round1(value):
    # Half-up like JavaScript's Math.round, not Python's banker's rounding, so scores match the TypeScript engine.
    return math.floor(float(value or 0) * 10.0 + 0.5) / 10.0


def tier_for(score, tiers):
    ordered = sorted(tiers, key=lambda item: item.get("min", 0), reverse=True)
    for tier in ordered:
        if score >= float(tier.get("min", 0)):
            return tier.get("label") or "Not ready"
    return "Not ready"


def next_daily_run(hour_utc, minute_utc=0):
    now = utcnow()
    candidate = now.replace(hour=hour_utc, minute=minute_utc, second=0, microsecond=0)
    if candidate <= now:
        candidate = candidate + timedelta(days=1)
    return candidate


# ---------------------------------------------------------------------------
# Run status, failure recording and safety checks
# ---------------------------------------------------------------------------

RUN_STATUS_PATH = "/lakehouse/default/Files/app/run_status.json"
ERROR_MAX_CHARS = 500
SHRINK_MIN_PREVIOUS_ROWS = 10
SHRINK_MIN_RATIO = 0.5

_SECRET_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*", re.I),
    re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}(?:\.[A-Za-z0-9_\-]*)?"),
    re.compile(r"\b(?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|api[_-]?key|sig)\b\s*[:=]\s*\S+", re.I),
]


def redact_error(value, limit=ERROR_MAX_CHARS):
    """Single-line, token-free error text capped at `limit` characters."""
    text = " ".join(str(value if value is not None else "").split())
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[redacted]", text)
    if len(text) > limit:
        text = text[: max(0, limit - 3)].rstrip() + "..."
    return text


def to_naive_utc(value):
    parsed = parse_timestamp(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def truthy(value):
    return str(value if value is not None else "").strip().lower() in {"1", "true", "yes", "y"}


def run_status_document(run_id, status, stage, started_at, finished_at=None, error=None, models=None):
    """The Files/app/run_status.json contract read by the app."""
    return {
        "runId": run_id,
        "status": status,
        "stage": stage,
        "startedAt": isoformat_z(started_at) or isoformat_z(utcnow()),
        "finishedAt": isoformat_z(finished_at),
        "error": redact_error(error) if error else None,
        "models": None if models is None else int(models),
    }


def write_run_status(run_id, status, stage, started_at, finished_at=None, error=None, models=None, path=None):
    write_json(path or RUN_STATUS_PATH, run_status_document(run_id, status, stage, started_at, finished_at, error, models))


def mark_run_failed(spark, run_id, started_utc, message, schema):
    """Sets the scan_runs row to Failed, keeping the counters and notes recorded so far."""
    row = {}
    try:
        existing = spark.table("scan_runs").where(f"run_id = '{run_id}'").collect()
        row = existing[0].asDict() if existing else {}
    except Exception as exc:
        log(f"Could not read the scan_runs row before marking it failed: {redact_error(exc)}")
    merge_table(
        spark,
        "scan_runs",
        [
            {
                "run_id": run_id,
                "started_utc": row.get("started_utc") or to_naive_utc(started_utc),
                "finished_utc": utcnow().replace(tzinfo=None),
                "status": "Failed",
                "workspaces_scanned": row.get("workspaces_scanned"),
                "models_found": row.get("models_found"),
                "notes": append_note(row.get("notes"), f"FAILED: {message}")[:4000],
            }
        ],
        schema,
        ["run_id"],
    )


def record_failure(spark, run_id, started_utc, stage, exc, schema, status_path=None):
    """Records a failed notebook run (scan_runs + run_status.json) and returns the redacted message.

    Never raises: the caller re-raises the original exception so the pipeline activity fails.
    """
    message = redact_error(f"{type(exc).__name__}: {exc}")
    log(f"Stage '{stage}' failed: {message}")
    if run_id:
        try:
            mark_run_failed(spark, run_id, started_utc, message, schema)
        except Exception as inner:
            log(f"Could not mark scan_runs as Failed: {redact_error(inner)}")
    try:
        write_run_status(run_id, "Failed", stage, started_utc, finished_at=utcnow(), error=message, path=status_path)
    except Exception as inner:
        log(f"Could not write run_status.json: {redact_error(inner)}")
    return message


def check_inventory_shrink(new_count, previous_count, allow=False):
    """Refuses to replace a good inventory with one that is suspiciously small (unless allow is set)."""
    new = int(new_count or 0)
    previous = int(previous_count or 0)
    if allow or previous <= 0:
        return
    collapsed = new == 0 or (previous > SHRINK_MIN_PREVIOUS_ROWS and new < previous * SHRINK_MIN_RATIO)
    if collapsed:
        raise RuntimeError(
            f"The new inventory has {new} model(s) but the previous run had {previous}. "
            "The last good data was left untouched. Check that the admin scan is complete (tenant settings, permissions, "
            "throttling); if the drop is expected, set ALLOW_SHRINK=true for this notebook and run it again."
        )


def scan_metadata_problem(workspaces):
    """Returns a message when the scanner returned models but no table metadata at all, else None.

    Without the detailed-metadata tenant settings the scanner still answers, but with empty schemas that would
    be scored as 'no measures'.
    """
    datasets = [dataset for workspace in workspaces for dataset in (workspace.get("datasets") or [])]
    if datasets and not any(dataset.get("tables") for dataset in datasets):
        return f"The admin scan returned {len(datasets)} semantic model(s) but no table, column or measure metadata."
    return None


def strip_user_lists(value):
    """Drops user/principal lists (emails) from scanner payloads before anything is stored."""
    if isinstance(value, dict):
        return {
            key: strip_user_lists(item)
            for key, item in value.items()
            if not (str(key).lower() == "users" or str(key).lower().endswith("users"))
        }
    if isinstance(value, list):
        return [strip_user_lists(item) for item in value]
    return value


# ---------------------------------------------------------------------------
# Quick score: pure functions over scanner-shaped JSON (no Spark). NB_03 calls these; backend/tests/test_parity.py
# runs them against the TypeScript engine (app/packages/engine/src/rules.ts is the source of truth).
# ---------------------------------------------------------------------------

SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2, "info": 3}


def _col_path(table_name, column_name):
    return f"{table_name}.{column_name}"


def _measure_path(table_name, measure_name):
    return f"{table_name}[{measure_name}]"


def _finding(rule_id, object_type, object_path, message, fix_kind, data=None):
    return {
        "ruleId": rule_id,
        "objectType": object_type,
        "objectPath": object_path,
        "message": message,
        "fixKind": fix_kind,
        "data": data or {},
    }


def build_model(dataset, inventory):
    """Scanner dataset + inventory row -> model dict; `coverage` records which fields the scanner exposed."""
    tables = []
    coverage = {
        "relationships": isinstance(dataset.get("relationships"), list),
        "table_descriptions": False,
        "column_descriptions": False,
        "measure_descriptions": False,
        "measure_expressions": False,
        "column_hidden": False,
        "table_hidden": False,
        "measure_hidden": False,
        "format_string": False,
        "is_key": False,
        "instructions": False,
        "qna_enabled": False,
        "approved_for_copilot": False,
        "copilot_schema": False,
        "copilot_indexing": False,
        "example_prompts": False,
    }

    for table in dataset.get("tables", []) or []:
        coverage["table_hidden"] = coverage["table_hidden"] or ("isHidden" in table)
        coverage["table_descriptions"] = coverage["table_descriptions"] or ("description" in table)
        table_item = {
            "name": table.get("name"),
            "description": table.get("description"),
            "isHidden": bool(table.get("isHidden")),
            "columns": [],
            "measures": [],
            "synonyms": table.get("synonyms") or [],
            "aiVisibility": table.get("visibility"),
        }
        for column in table.get("columns", []) or []:
            coverage["column_hidden"] = coverage["column_hidden"] or ("isHidden" in column)
            coverage["column_descriptions"] = coverage["column_descriptions"] or ("description" in column)
            coverage["format_string"] = coverage["format_string"] or ("formatString" in column)
            coverage["is_key"] = coverage["is_key"] or ("isKey" in column)
            table_item["columns"].append(
                {
                    "name": column.get("name"),
                    "dataType": column.get("dataType"),
                    "description": column.get("description"),
                    "isHidden": bool(column.get("isHidden")),
                    "isKey": bool(column.get("isKey", False)),
                    "formatString": column.get("formatString"),
                    "summarizeBy": (column.get("summarizeBy") or "").lower() or None,
                    "columnType": column.get("columnType"),
                    "synonyms": column.get("synonyms") or [],
                    "aiVisibility": column.get("visibility"),
                }
            )
        for measure in table.get("measures", []) or []:
            coverage["measure_hidden"] = coverage["measure_hidden"] or ("isHidden" in measure)
            coverage["measure_descriptions"] = coverage["measure_descriptions"] or ("description" in measure)
            coverage["measure_expressions"] = coverage["measure_expressions"] or ("expression" in measure)
            coverage["format_string"] = coverage["format_string"] or ("formatString" in measure)
            table_item["measures"].append(
                {
                    "name": measure.get("name"),
                    "description": measure.get("description"),
                    "expression": measure.get("expression") or "",
                    "isHidden": bool(measure.get("isHidden")),
                    "formatString": measure.get("formatString"),
                    "synonyms": measure.get("synonyms") or [],
                    "aiVisibility": measure.get("visibility"),
                }
            )
        tables.append(table_item)

    governance = {
        "qnaEnabled": None,
        "approvedForCopilot": None,
        "endorsement": inventory.get("endorsement"),
        "capacityEligible": inventory.get("on_dedicated_capacity"),
    }
    return {
        "name": inventory.get("model_name") or dataset.get("name"),
        "tables": tables,
        "relationships": dataset.get("relationships") or [],
        "governance": governance,
        "metadataOnly": True,
        "coverage": coverage,
    }


def _is_table_in_scope(table):
    return not table.get("isHidden") and table.get("aiVisibility") != "Hidden"


def _build_ctx(model):
    tables = [table for table in model["tables"] if _is_table_in_scope(table)]
    columns = []
    measures = []
    rel_cols = set()
    for relationship in model.get("relationships") or []:
        rel_cols.add((relationship.get("fromTable"), relationship.get("fromColumn")))
        rel_cols.add((relationship.get("toTable"), relationship.get("toColumn")))
    for table in tables:
        for column in table.get("columns", []):
            if not column.get("isHidden") and column.get("aiVisibility") != "Hidden":
                columns.append({"table": table, "column": column})
        for measure in table.get("measures", []):
            if not measure.get("isHidden") and measure.get("aiVisibility") != "Hidden":
                measures.append({"table": table, "measure": measure})
    return {"tables": tables, "columns": columns, "measures": measures, "relCols": rel_cols, "model": model}


def _category_rules(catalog, category_id):
    return [rule for rule in catalog["rules"] if rule["category"] == category_id]


def _fnd001(ctx):
    measure_count = sum(len(table.get("measures", [])) for table in ctx["model"]["tables"])
    findings = []
    if measure_count == 0:
        findings.append(_finding("FND-001", "model", ctx["model"]["name"], "The model has no explicit measures.", "add-measure"))
        return 0.0, "No explicit measures in the model.", findings
    score = min(1.0, 0.5 + 0.1 * measure_count)
    if score < 1:
        findings.append(
            _finding(
                "FND-001",
                "model",
                ctx["model"]["name"],
                f"Only {measure_count} explicit measure(s); add measures for the key numbers.",
                "add-measure",
            )
        )
    return score, f"{measure_count} explicit measure(s).", findings


def _is_key_column(column):
    return column.get("dataType") != "DateTime" and (column.get("isKey") or is_key_like_name(column.get("name")))


def _fnd005(ctx):
    key_like = [item for item in ctx["columns"] if _is_key_column(item["column"])]
    # The denominator counts every key-like column of a non-hidden table, hidden ones included.
    all_key_like = [
        column
        for table in ctx["model"]["tables"]
        if not table.get("isHidden")
        for column in table.get("columns", [])
        if _is_key_column(column)
    ]
    if not all_key_like:
        return None, "No key-like columns.", []
    findings = [
        _finding(
            "FND-005",
            "column",
            _col_path(item["table"]["name"], item["column"]["name"]),
            "Technical key column is visible.",
            "hide-object",
            {"table": item["table"]["name"], "name": item["column"]["name"], "type": "column"},
        )
        for item in key_like
    ]
    return 1 - (len(key_like) / float(len(all_key_like))), f"{len(key_like)} of {len(all_key_like)} key-like column(s) are visible.", findings


def _fnd006(ctx):
    if not ctx["model"]["coverage"]["format_string"]:
        return None, "Format strings are not exposed by the scanner.", []
    if not ctx["measures"]:
        return None, "No visible measures.", []
    missing = [item for item in ctx["measures"] if not item["measure"].get("formatString")]
    findings = [
        _finding(
            "FND-006",
            "measure",
            _measure_path(item["table"]["name"], item["measure"]["name"]),
            "Measure has no format string.",
            "set-format-string",
            {"table": item["table"]["name"], "name": item["measure"]["name"]},
        )
        for item in missing
    ]
    return 1 - (len(missing) / float(len(ctx["measures"]))), f"{len(missing)} of {len(ctx['measures'])} visible measure(s) have no format string.", findings


def _fnd008(ctx):
    fields = len(ctx["columns"]) + len(ctx["measures"])
    score = 1.0
    if fields > 150:
        score = max(0.2, 1 - ((fields - 150) / 350.0))
    findings = []
    if score < 1:
        findings.append(
            _finding(
                "FND-008",
                "model",
                ctx["model"]["name"],
                f"{fields} visible fields are in AI scope; hide unused fields or scope the AI data schema.",
                "set-ai-visibility",
            )
        )
    return score, f"{fields} visible field(s) in AI scope.", findings


def _nam001(ctx):
    if not ctx["tables"]:
        return None, "No visible tables.", []
    bad = [table for table in ctx["tables"] if is_technical_table_name(table["name"])]
    findings = [
        _finding("NAM-001", "table", table["name"], f'Table name "{table["name"]}" is technical.', "manual", {"table": table["name"]})
        for table in bad
    ]
    return 1 - (len(bad) / float(len(ctx["tables"]))), f"{len(bad)} of {len(ctx['tables'])} visible table name(s) are technical.", findings


def _nam002(ctx):
    total = len(ctx["columns"]) + len(ctx["measures"])
    if total == 0:
        return None, "No visible fields.", []
    bad = []
    findings = []
    for item in ctx["columns"]:
        if not is_friendly_name(item["column"]["name"]):
            bad.append(item)
            findings.append(
                _finding(
                    "NAM-002",
                    "column",
                    _col_path(item["table"]["name"], item["column"]["name"]),
                    f'Column name "{item["column"]["name"]}" is not business-friendly.',
                    "manual",
                    {"table": item["table"]["name"], "name": item["column"]["name"]},
                )
            )
    for item in ctx["measures"]:
        if not is_friendly_name(item["measure"]["name"]):
            bad.append(item)
            findings.append(
                _finding(
                    "NAM-002",
                    "measure",
                    _measure_path(item["table"]["name"], item["measure"]["name"]),
                    f'Measure name "{item["measure"]["name"]}" is not business-friendly.',
                    "manual",
                    {"table": item["table"]["name"], "name": item["measure"]["name"]},
                )
            )
    return 1 - (len(bad) / float(total)), f"{len(bad)} of {total} visible field name(s) are not business-friendly.", findings


def _nam003(ctx):
    total = len(ctx["tables"]) + len(ctx["columns"]) + len(ctx["measures"])
    if total == 0:
        return None, "No visible objects.", []
    bad = 0
    findings = []
    for table in ctx["tables"]:
        abbreviations = [item for item in abbreviations_in(table["name"]) if item not in {"dim", "fct", "tbl"}]
        if abbreviations:
            bad += 1
            findings.append(
                _finding("NAM-003", "table", table["name"], f"Abbreviation(s) in table name: {', '.join(abbreviations)}.", "manual", {"table": table["name"]})
            )
    for item in ctx["columns"]:
        abbreviations = abbreviations_in(item["column"]["name"])
        if abbreviations:
            bad += 1
            findings.append(
                _finding(
                    "NAM-003",
                    "column",
                    _col_path(item["table"]["name"], item["column"]["name"]),
                    f"Abbreviation(s): {', '.join(abbreviations)}.",
                    "manual",
                    {"table": item["table"]["name"], "name": item["column"]["name"]},
                )
            )
    for item in ctx["measures"]:
        abbreviations = abbreviations_in(item["measure"]["name"])
        if abbreviations:
            bad += 1
            findings.append(
                _finding(
                    "NAM-003",
                    "measure",
                    _measure_path(item["table"]["name"], item["measure"]["name"]),
                    f"Abbreviation(s): {', '.join(abbreviations)}.",
                    "manual",
                    {"table": item["table"]["name"], "name": item["measure"]["name"]},
                )
            )
    return 1 - (bad / float(total)), f"{bad} of {total} visible name(s) contain abbreviations.", findings


def _nam004(ctx):
    if not ctx["columns"]:
        return None, "No visible columns.", []
    by_name = {}
    for item in ctx["columns"]:
        if item["column"].get("isKey") or is_key_like_name(item["column"]["name"]):
            continue
        by_name.setdefault(item["column"]["name"].lower(), []).append(item)
    duplicates = []
    for rows in by_name.values():
        if len({row["table"]["name"] for row in rows}) > 1:
            duplicates.extend(rows)
    findings = [
        _finding(
            "NAM-004",
            "column",
            _col_path(item["table"]["name"], item["column"]["name"]),
            f'Column name "{item["column"]["name"]}" also exists in another table.',
            "manual",
            {"table": item["table"]["name"], "name": item["column"]["name"]},
        )
        for item in duplicates
    ]
    return 1 - min(1.0, (len(duplicates) / float(len(ctx["columns"]))) * 2.0), f"{len(duplicates)} column(s) share a visible name with a column in another table.", findings


def _dsc001(ctx):
    if not ctx["model"]["coverage"]["table_descriptions"]:
        return None, "Table descriptions are not exposed by the scanner.", []
    if not ctx["tables"]:
        return None, "No visible tables.", []
    missing = [table for table in ctx["tables"] if not str(table.get("description") or "").strip()]
    findings = [_finding("DSC-001", "table", table["name"], "Table has no description.", "add-description", {"table": table["name"]}) for table in missing]
    return 1 - (len(missing) / float(len(ctx["tables"]))), f"{len(ctx['tables']) - len(missing)} of {len(ctx['tables'])} visible table(s) have a description.", findings


def _dsc002(ctx):
    if not ctx["model"]["coverage"]["measure_descriptions"]:
        return None, "Measure descriptions are not exposed by the scanner.", []
    if not ctx["measures"]:
        return None, "No visible measures.", []
    missing = [item for item in ctx["measures"] if not str(item["measure"].get("description") or "").strip()]
    findings = [
        _finding(
            "DSC-002",
            "measure",
            _measure_path(item["table"]["name"], item["measure"]["name"]),
            "Measure has no description.",
            "add-description",
            {"table": item["table"]["name"], "name": item["measure"]["name"]},
        )
        for item in missing
    ]
    return 1 - (len(missing) / float(len(ctx["measures"]))), f"{len(ctx['measures']) - len(missing)} of {len(ctx['measures'])} visible measure(s) have a description.", findings


def _dsc003(ctx):
    if not ctx["model"]["coverage"]["column_descriptions"]:
        return None, "Column descriptions are not exposed by the scanner.", []
    if not ctx["columns"]:
        return None, "No visible columns.", []
    missing = [item for item in ctx["columns"] if not str(item["column"].get("description") or "").strip()]
    findings = [
        _finding(
            "DSC-003",
            "column",
            _col_path(item["table"]["name"], item["column"]["name"]),
            "Column has no description.",
            "add-description",
            {"table": item["table"]["name"], "name": item["column"]["name"]},
        )
        for item in missing
    ]
    return 1 - (len(missing) / float(len(ctx["columns"]))), f"{len(ctx['columns']) - len(missing)} of {len(ctx['columns'])} visible column(s) have a description.", findings


def _dsc004(ctx):
    coverage = ctx["model"]["coverage"]
    if not (coverage["table_descriptions"] or coverage["column_descriptions"] or coverage["measure_descriptions"]):
        return None, "Descriptions are not exposed by the scanner.", []
    items = []
    for table in ctx["tables"]:
        if str(table.get("description") or "").strip():
            items.append(("table", table["name"], table["name"], table.get("description"), {"table": table["name"]}))
    for item in ctx["columns"]:
        if str(item["column"].get("description") or "").strip():
            items.append(
                (
                    "column",
                    _col_path(item["table"]["name"], item["column"]["name"]),
                    item["column"]["name"],
                    item["column"].get("description"),
                    {"table": item["table"]["name"], "name": item["column"]["name"]},
                )
            )
    for item in ctx["measures"]:
        if str(item["measure"].get("description") or "").strip():
            items.append(
                (
                    "measure",
                    _measure_path(item["table"]["name"], item["measure"]["name"]),
                    item["measure"]["name"],
                    item["measure"].get("description"),
                    {"table": item["table"]["name"], "name": item["measure"]["name"]},
                )
            )
    if not items:
        return None, "No descriptions to assess.", []
    # One pass per model: how often each normalised text occurs per kind of object.
    keys = [(entry[0], normalize_description(entry[3])) for entry in items]
    seen = {}
    for key in keys:
        seen[key] = seen.get(key, 0) + 1
    findings = []
    for entry, key in zip(items, keys):
        problem = description_problem(entry[2], entry[3], seen[key])
        if problem:
            findings.append(_finding("DSC-004", entry[0], entry[1], DESCRIPTION_PROBLEM_MESSAGE[problem], "add-description", entry[4]))
    bad = len(findings)
    long_count = len([entry for entry in items if len(str(entry[3] or "")) > 200])
    evidence = f"{bad} of {len(items)} description(s) are not informative"
    if long_count:
        evidence += f"; {long_count} exceed 200 characters"
    evidence += "."
    return 1 - (bad / float(len(items))), evidence, findings


def _gov001(ctx):
    qna_enabled = ctx["model"]["governance"].get("qnaEnabled")
    if qna_enabled is None:
        return None, "Q&A state unknown.", []
    findings = [] if qna_enabled else [_finding("GOV-001", "model", ctx["model"]["name"], "Q&A is disabled on the model.", "set-qna")]
    return (1.0 if qna_enabled else 0.0), ("Q&A is enabled." if qna_enabled else "Q&A is disabled."), findings


def _gov002(ctx):
    approved = ctx["model"]["governance"].get("approvedForCopilot")
    if approved is None:
        return None, "Approved-for-Copilot state unknown.", []
    findings = [] if approved else [_finding("GOV-002", "model", ctx["model"]["name"], "Model is not approved for Copilot.", "manual")]
    return (1.0 if approved else 0.0), ("Approved for Copilot." if approved else "Not approved for Copilot."), findings


def _gov003(ctx):
    endorsement = ctx["model"]["governance"].get("endorsement")
    if endorsement is None:
        return None, "Endorsement unknown.", []
    score = 1.0 if endorsement in {"Certified", "MasterData"} else (0.8 if endorsement == "Promoted" else 0.0)
    findings = [] if score >= 0.8 else [_finding("GOV-003", "model", ctx["model"]["name"], "Model is not endorsed.", "manual")]
    return score, f"Endorsement: {endorsement}.", findings


RULE_IMPLS = {
    "FND-001": _fnd001,
    "FND-005": _fnd005,
    "FND-006": _fnd006,
    "FND-008": _fnd008,
    "NAM-001": _nam001,
    "NAM-002": _nam002,
    "NAM-003": _nam003,
    "NAM-004": _nam004,
    "DSC-001": _dsc001,
    "DSC-002": _dsc002,
    "DSC-003": _dsc003,
    "DSC-004": _dsc004,
    "GOV-001": _gov001,
    "GOV-002": _gov002,
    "GOV-003": _gov003,
}


def evaluate_rules(model, catalog):
    ctx = _build_ctx(model)
    results = []
    for rule in catalog["rules"]:
        rule_id = rule["id"]
        if rule.get("deepOnly"):
            results.append({"ruleId": rule_id, "score": None, "evidence": "Requires the full model definition (deep scan).", "findings": []})
            continue
        if rule_id.startswith("INS-"):
            results.append({"ruleId": rule_id, "score": None, "evidence": "AI instructions are not exposed by the scanner.", "findings": []})
            continue
        impl = RULE_IMPLS.get(rule_id)
        if impl is None:
            results.append({"ruleId": rule_id, "score": None, "evidence": "Not evaluated.", "findings": []})
            continue
        score, evidence, findings = impl(ctx)
        if score is not None:
            score = max(0.0, min(1.0, float(score)))
        results.append({"ruleId": rule_id, "score": score, "evidence": evidence, "findings": findings[:150]})
    return results


def score_model(model, catalog):
    rule_results = evaluate_rules(model, catalog)
    rule_by_id = {row["ruleId"]: row for row in rule_results}
    categories = []
    weighted_sum = 0.0
    weight_applicable = 0.0
    for category_id, category_meta in catalog["categories"].items():
        numerator = 0.0
        denominator = 0.0
        for rule in _category_rules(catalog, category_id):
            result = rule_by_id[rule["id"]]
            if result["score"] is None:
                continue
            numerator += float(rule["weight"]) * float(result["score"])
            denominator += float(rule["weight"])
        category_score = 0.0 if denominator == 0 else (numerator / denominator) * 100.0
        if denominator > 0:
            weighted_sum += float(category_meta["weight"]) * (category_score / 100.0)
            weight_applicable += float(category_meta["weight"])
        categories.append(
            {
                "id": category_id,
                "title": category_meta["title"],
                "weight": category_meta["weight"],
                "score": round1(category_score),
                "points": 0.0,
            }
        )
    raw_score = 0.0 if weight_applicable == 0 else (weighted_sum / weight_applicable) * 100.0
    for category in categories:
        applicable = any(rule["category"] == category["id"] and rule_by_id[rule["id"]]["score"] is not None for rule in catalog["rules"])
        category["points"] = round1((category["weight"] * (category["score"] / 100.0) * 100.0) / weight_applicable) if applicable and weight_applicable > 0 else 0.0

    explicit_measures = sum(len(table.get("measures", [])) for table in model["tables"])
    gates = []
    for gate in catalog["gates"]:
        triggered = False
        if gate["id"] == "GATE-NO-MEASURES":
            triggered = explicit_measures == 0
        elif gate["id"] == "GATE-QNA-OFF":
            triggered = model["governance"].get("qnaEnabled") is False
        elif gate["id"] == "GATE-NO-CAPACITY":
            triggered = model["governance"].get("capacityEligible") is False
        gates.append({"id": gate["id"], "title": gate["title"], "cap": gate["cap"], "triggered": triggered})
    cap = 100.0
    for gate in gates:
        if gate["triggered"]:
            cap = min(cap, float(gate["cap"]))
    score = min(raw_score, cap)
    findings = [finding for result in rule_results for finding in result["findings"]]

    return {
        "catalogVersion": catalog["version"],
        "mode": "quick",
        "modelName": model["name"],
        "score": round1(score),
        "rawScore": round1(raw_score),
        "tier": tier_for(score, catalog["tiers"]),
        "categories": categories,
        "gates": gates,
        "rules": rule_results,
        "findings": findings,
    }


def top_findings(score_result, catalog_by_id):
    def sort_key(item):
        meta = catalog_by_id[item["ruleId"]]
        return (
            SEVERITY_ORDER.get(meta.get("severity"), 9),
            -int(meta.get("weight", 0)),
            item["ruleId"],
            item["objectPath"],
        )

    ordered = sorted(score_result["findings"], key=sort_key)
    top = []
    for finding in ordered[:10]:
        meta = catalog_by_id[finding["ruleId"]]
        top.append(
            {
                "ruleId": finding["ruleId"],
                "severity": meta.get("severity"),
                "title": meta.get("title"),
                "objectType": finding["objectType"],
                "objectPath": finding["objectPath"],
                "message": finding["message"],
                "fixKind": finding["fixKind"],
            }
        )
    return top


def coverage_summary(detail_rows):
    dataset_keys = set()
    table_keys = set()
    column_keys = set()
    measure_keys = set()
    relationships_present = False
    for row in detail_rows:
        dataset = json.loads(row["dataset_json"])
        dataset_keys.update(dataset.keys())
        if isinstance(dataset.get("relationships"), list):
            relationships_present = True
        for table in dataset.get("tables", []) or []:
            table_keys.update(table.keys())
            for column in table.get("columns", []) or []:
                column_keys.update(column.keys())
            for measure in table.get("measures", []) or []:
                measure_keys.update(measure.keys())
    return {
        "dataset_keys": sorted(dataset_keys),
        "table_keys": sorted(table_keys),
        "column_keys": sorted(column_keys),
        "measure_keys": sorted(measure_keys),
        "relationships_present": relationships_present,
        "supports": {
            "table_description": "description" in table_keys,
            "column_description": "description" in column_keys,
            "measure_description": "description" in measure_keys,
            "column_hidden": "isHidden" in column_keys,
            "measure_hidden": "isHidden" in measure_keys,
            "table_hidden": "isHidden" in table_keys,
            "measure_expression": "expression" in measure_keys,
            "storage_mode": "storageMode" in table_keys or "targetStorageMode" in dataset_keys,
            "relationships": relationships_present,
            "format_string": "formatString" in column_keys or "formatString" in measure_keys,
            "is_key": "isKey" in column_keys,
            "qna_enabled": "qnaEnabled" in dataset_keys,
            "approved_for_copilot": "approvedForCopilot" in dataset_keys,
            "endorsement": "endorsementDetails" in dataset_keys,
            "copilot_instructions": False,
            "copilot_schema": False,
            "copilot_indexing": False,
            "example_prompts": False,
        },
    }


# ---------------------------------------------------------------------------
# Portfolio export (Files/app/portfolio.json)
# ---------------------------------------------------------------------------

USAGE_WINDOW_DAYS = 28
_EPOCH = datetime(1970, 1, 1)


def _iso(value):
    return isoformat_z(value) if value is not None else None


def _int(value):
    return None if value is None else int(value)


def latest_usage_by_model(usage_rows):
    latest = {}
    for item in usage_rows:
        key = (item["workspace_id"], item["model_id"])
        current = latest.get(key)
        if current is None or (item.get("collected_utc") or _EPOCH) >= (current.get("collected_utc") or _EPOCH):
            latest[key] = item
    return latest


def build_portfolio(run_id, catalog_version, inventory_rows, score_rows, usage_by_model, detail_by_model):
    score_by_model = {(row["workspace_id"], row["model_id"]): row for row in score_rows}
    models = []
    workspaces = {}
    for inv in inventory_rows:
        key = (inv["workspace_id"], inv["model_id"])
        workspaces[inv["workspace_id"]] = inv.get("workspace_name") or inv["workspace_id"]
        usage = usage_by_model.get(key)
        score = score_by_model.get(key)
        refreshed = inv.get("last_refresh_utc")
        categories = {}
        if score and score.get("categories_json"):
            categories = {item["id"]: item["score"] for item in json.loads(score["categories_json"])}
        scan_error = None
        if key not in detail_by_model:
            scan_error = "The model definition could not be read, so the score is based on inventory metadata only."
        elif not inv.get("table_count"):
            scan_error = "The scan returned no table metadata for this model, so it was scored as an empty model."
        models.append(
            {
                "workspaceId": inv["workspace_id"],
                "workspaceName": inv.get("workspace_name") or inv["workspace_id"],
                "modelId": inv["model_id"],
                "name": inv.get("model_name") or inv["model_id"],
                "configuredBy": inv.get("configured_by"),
                "createdDate": _iso(inv.get("created_date")),
                "targetStorageMode": inv.get("storage_mode"),
                "isRefreshable": inv.get("is_refreshable"),
                # The status is what the refresh history reported; "Unknown" when it was not collected.
                "lastRefresh": {"status": inv.get("last_refresh_status") or "Unknown", "endTime": _iso(refreshed)} if refreshed else None,
                "usage": {
                    "reportsCount": _int(inv.get("report_count")),
                    "views30d": _int(usage.get("view_events")) if usage else None,
                    "uniqueUsers30d": _int(usage.get("distinct_users")) if usage else None,
                    "lastActivity": _iso(usage.get("last_activity_utc")) if usage else None,
                }
                if usage
                else None,
                "quickScore": {"score": score["score"], "tier": score["tier"], "categories": categories} if score else None,
                "tables": _int(inv.get("table_count")),
                "measures": _int(inv.get("measure_count")),
                "scanError": scan_error,
            }
        )
    models.sort(key=lambda item: (item["workspaceName"].lower(), item["name"].lower()))
    return {
        "generatedAt": _iso(utcnow()),
        "runId": run_id,
        "catalogVersion": catalog_version,
        "usageWindowDays": USAGE_WINDOW_DAYS,
        "workspaces": [{"id": wid, "name": name} for wid, name in sorted(workspaces.items(), key=lambda kv: kv[1].lower())],
        "models": models,
    }
