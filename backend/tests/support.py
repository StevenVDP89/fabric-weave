"""Test support: loads backend/notebooks/_shared.py without Spark and runs the NB_0x notebook files against an
in-memory fake of Spark, the Power BI HTTP APIs and the lakehouse Files folder (a scratch folder under backend/tests)."""

import contextlib
import importlib.util
import json
import re
import shutil
import sys
import tempfile
import types
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parents[1]
NOTEBOOKS_DIR = ROOT / "backend" / "notebooks"
SHARED_PATH = NOTEBOOKS_DIR / "_shared.py"
CATALOG_PATH = ROOT / "backend" / "catalog" / "rule-catalog.json"
FIXTURES_PATH = TESTS_DIR / "fixtures" / "scanner_models.json"

LAKEHOUSE_PREFIX = "/lakehouse/default/"


def load_shared():
    spec = importlib.util.spec_from_file_location("notebook_shared_under_test", SHARED_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


class Workdir:
    """A scratch folder inside backend/tests (never the system temp folder), removed on cleanup."""

    def __init__(self):
        self.path = Path(tempfile.mkdtemp(prefix="_work_", dir=TESTS_DIR))

    def file(self, relative):
        return self.path / relative

    def cleanup(self):
        shutil.rmtree(self.path, ignore_errors=True)

    def leftovers(self):
        return sorted(str(p.relative_to(self.path)) for p in self.path.rglob("*.tmp"))


class FakeRow(dict):
    def asDict(self):
        return dict(self)


class FakeFrame:
    def __init__(self, rows):
        self._rows = [FakeRow(row) for row in rows]

    def where(self, condition):
        match = re.fullmatch(r"run_id = '([^']*)'", condition.strip())
        if not match:
            raise AssertionError(f"unsupported filter in the fake Spark: {condition}")
        return FakeFrame([row for row in self._rows if row.get("run_id") == match.group(1)])

    def select(self, *columns):
        return FakeFrame([{column: row[column] for column in columns} for row in self._rows])

    def collect(self):
        return list(self._rows)

    def count(self):
        return len(self._rows)


class FakeSpark:
    """Tables are lists of row dicts. `writes` records every overwrite/merge so tests can prove nothing was touched."""

    def __init__(self, tables=None):
        self.tables = {name: [dict(row) for row in rows] for name, rows in (tables or {}).items()}
        self.writes = []

    def table(self, name):
        if name not in self.tables:
            raise KeyError(f"table not found: {name}")
        return FakeFrame(self.tables[name])

    def written(self, name):
        return [op for op, table in self.writes if table == name]


def _fake_overwrite_table(spark, name, rows, schema):
    spark.writes.append(("overwrite", name))
    spark.tables[name] = [dict(row) for row in rows]


def _fake_merge_table(spark, name, rows, schema, key_columns):
    spark.writes.append(("merge", name))
    existing = spark.tables.setdefault(name, [])
    for row in rows:
        for index, current in enumerate(existing):
            if all(current.get(key) == row.get(key) for key in key_columns):
                existing[index] = dict(row)
                break
        else:
            existing.append(dict(row))


def _fake_table_exists(spark, name):
    return name in spark.tables


class _AnyType:
    def __init__(self, *args, **kwargs):
        self.args = args


def _fake_pyspark_modules():
    types_module = types.ModuleType("pyspark.sql.types")
    types_module.__getattr__ = lambda name: _AnyType
    sql_module = types.ModuleType("pyspark.sql")
    sql_module.types = types_module
    pyspark_module = types.ModuleType("pyspark")
    pyspark_module.sql = sql_module
    return {"pyspark": pyspark_module, "pyspark.sql": sql_module, "pyspark.sql.types": types_module}


class HttpScript:
    """Answers shared.http_json calls from a handler(method, url, **kwargs) -> payload and records the URLs."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url))
        payload = self.handler(method, url, **kwargs)
        return 200, {}, payload


def run_notebook(name, work, spark, http=None):
    """Executes backend/notebooks/<name> with /lakehouse/default/ redirected to the scratch folder.

    Returns the notebook namespace. Exceptions raised by the notebook propagate to the caller.
    """
    source = (NOTEBOOKS_DIR / name).read_text(encoding="utf-8").replace(LAKEHOUSE_PREFIX, work.path.as_posix() + "/")
    real_spec_from_file_location = importlib.util.spec_from_file_location

    def patch_shared(shared):
        shared.overwrite_table = _fake_overwrite_table
        shared.merge_table = _fake_merge_table
        shared.table_exists = _fake_table_exists
        shared.get_token = lambda *candidates: "fake-token"
        shared.RUN_STATUS_PATH = (work.path / "Files" / "app" / "run_status.json").as_posix()
        if http is not None:
            shared.http_json = http

    def spec_from_file_location(module_name, location, *args, **kwargs):
        spec = real_spec_from_file_location(module_name, str(SHARED_PATH))
        real_loader = spec.loader

        class HookedLoader:
            def create_module(self, module_spec):
                return real_loader.create_module(module_spec)

            def exec_module(self, module):
                real_loader.exec_module(module)
                patch_shared(module)

        spec.loader = HookedLoader()
        return spec

    namespace = {"__name__": "notebook_under_test", "spark": spark}
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(sys.modules, _fake_pyspark_modules()))
        stack.enter_context(mock.patch.object(importlib.util, "spec_from_file_location", spec_from_file_location))
        stack.enter_context(mock.patch("time.sleep", lambda seconds: None))
        exec(compile(source, name, "exec"), namespace)
    return namespace
