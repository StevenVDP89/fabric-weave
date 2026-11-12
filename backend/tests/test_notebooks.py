"""Failure-path tests for the notebooks: NB_01/02/03 are executed against an in-memory Spark, scripted Power BI API
answers and a scratch Files folder (see support.py). They prove that a failed run
  - raises (so the pipeline activity fails),
  - records status 'Failed' in scan_runs and in Files/app/run_status.json,
  - and leaves the previously written tables and portfolio.json untouched.

Run from the repo root:  python -m unittest discover -s backend/tests -p "test_*.py"
"""

import json
import os
import shutil
import unittest
from datetime import datetime
from unittest import mock

import support

FIXTURES = support.read_json(support.FIXTURES_PATH)
RUN_ID = "scan-20260102T030405Z-abcd1234"
STARTED = "2026-01-02T03:04:05Z"
OLD_PORTFOLIO = {"generatedAt": "2025-12-31T00:00:00Z", "models": [{"modelId": "old"}]}


def scanner_workspaces(with_tables=True):
    datasets = []
    for entry in FIXTURES:
        dataset = {"id": entry["id"], **entry["dataset"], "configuredBy": "owner@contoso.com", "users": [{"emailAddress": "reader@users-only.example"}]}
        if not with_tables:
            dataset["tables"] = []
        datasets.append(dataset)
    return [
        {
            "id": "ws-1",
            "name": "Finance",
            "capacityId": "cap-1",
            "isOnDedicatedCapacity": True,
            "users": [{"emailAddress": "admin@users-only.example"}],
            "datasets": datasets,
            "reports": [{"id": "r1", "datasetId": FIXTURES[0]["id"], "users": [{"emailAddress": "viewer@users-only.example"}]}],
        }
    ]


def inventory_row(index, name=None):
    return {"workspace_id": "ws-1", "workspace_name": "Finance", "model_id": f"old-{index}", "model_name": name or f"Old {index}"}


class NotebookCase(unittest.TestCase):
    def setUp(self):
        self.work = support.Workdir()
        self.addCleanup(self.work.cleanup)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("ALLOW_SHRINK", None)
        self.portfolio_path = self.work.file("Files/app/portfolio.json")
        self.status_path = self.work.file("Files/app/run_status.json")
        self.run_state_path = self.work.file("Files/system/ai_readiness/current_run.json")

    def seed_portfolio(self):
        self.portfolio_path.parent.mkdir(parents=True, exist_ok=True)
        self.portfolio_path.write_text(json.dumps(OLD_PORTFOLIO), encoding="utf-8")

    def seed_run_state(self):
        self.run_state_path.parent.mkdir(parents=True, exist_ok=True)
        self.run_state_path.write_text(json.dumps({"run_id": RUN_ID, "started_utc": STARTED}), encoding="utf-8")

    def assert_portfolio_untouched(self):
        self.assertEqual(support.read_json(self.portfolio_path), OLD_PORTFOLIO)

    def assert_failed(self, spark, stage, run_id=RUN_ID):
        status = support.read_json(self.status_path)
        self.assertEqual(status["status"], "Failed")
        self.assertEqual(status["stage"], stage)
        self.assertEqual(status["runId"], run_id)
        self.assertTrue(status["finishedAt"])
        self.assertTrue(status["error"])
        self.assertLessEqual(len(status["error"]), 500)
        self.assertNotIn("secret-token", status["error"])
        runs = [row for row in spark.tables.get("scan_runs", []) if row["run_id"] == run_id]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["status"], "Failed")
        self.assertIn("FAILED:", runs[0]["notes"])
        self.assertNotIn("secret-token", runs[0]["notes"])
        self.assertEqual(self.work.leftovers(), [])


class ScanInventoryTests(NotebookCase):
    def handler(self, workspaces, calls=None, dataset_details_fail=False):
        def handle(method, url, **kwargs):
            if calls is not None:
                calls.append((method, url))
            if "/admin/workspaces/modified" in url:
                return [{"id": "ws-1"}]
            if "/admin/workspaces/getInfo" in url:
                return {"id": "scan-1"}
            if "/admin/workspaces/scanStatus/" in url:
                return {"status": "Succeeded"}
            if "/admin/workspaces/scanResult/" in url:
                return {"workspaces": workspaces}
            if "/refreshes" in url:
                return {"value": [{"status": "Failed", "endTime": "2026-01-01T06:00:00Z"}]}
            if "/datasets/" in url:
                if dataset_details_fail:
                    raise RuntimeError("HTTP 404")
                return {"isRefreshable": True}
            raise AssertionError(f"unexpected call {method} {url}")

        return handle

    def run_nb01(self, spark, handler):
        return support.run_notebook("NB_01_Scan_Inventory.py", self.work, spark, support.HttpScript(handler))

    def test_success_writes_inventory_status_and_a_user_free_scan_result(self):
        calls = []
        spark = support.FakeSpark()
        self.run_nb01(spark, self.handler(scanner_workspaces(), calls))

        inventory = spark.tables["model_inventory"]
        self.assertEqual(len(inventory), len(FIXTURES))
        self.assertEqual({row["last_refresh_status"] for row in inventory}, {"Failed"})
        self.assertEqual(len(spark.tables["model_scan_detail"]), len(FIXTURES))
        self.assertEqual(spark.tables["scan_runs"][0]["status"], "InventoryCompleted")

        status = support.read_json(self.status_path)
        self.assertEqual((status["status"], status["stage"]), ("Running", "scan"))
        self.assertIsNone(status["finishedAt"])
        self.assertEqual(status["runId"], spark.tables["scan_runs"][0]["run_id"])

        run_state = support.read_json(self.run_state_path)
        self.assertEqual(run_state["run_id"], status["runId"])
        self.assertEqual(run_state["model_count"], len(FIXTURES))

        raw = self.work.file(f"Files/system/ai_readiness/scans/{status['runId']}/scan_result.json").read_text(encoding="utf-8")
        self.assertNotIn("users-only.example", raw)
        self.assertNotIn('"users"', raw)
        for row in spark.tables["model_scan_detail"]:
            self.assertNotIn("users-only.example", row["dataset_json"])
        self.assertFalse([url for _, url in calls if "getArtifactUsers" in url])
        self.assertEqual(self.work.leftovers(), [])

    def test_admin_scan_failure_fails_the_notebook_and_keeps_the_last_good_data(self):
        spark = support.FakeSpark({"model_inventory": [inventory_row(i) for i in range(20)], "model_scan_detail": [{"run_id": "old"}]})
        self.seed_portfolio()

        def handle(method, url, **kwargs):
            raise RuntimeError("HTTP 403 for admin api: Bearer secret-token-value")

        with self.assertRaises(RuntimeError) as caught:
            self.run_nb01(spark, handle)

        self.assertIn("tenant admin scan failed", str(caught.exception))
        self.assertIn("tenant settings", str(caught.exception))
        self.assertEqual(spark.written("model_inventory"), [])
        self.assertEqual(spark.written("model_scan_detail"), [])
        self.assertEqual(len(spark.tables["model_inventory"]), 20)
        self.assert_portfolio_untouched()
        status = support.read_json(self.status_path)
        self.assert_failed(spark, "scan", run_id=status["runId"])
        self.assertIn("tenant settings", status["error"])
        self.assertFalse(self.run_state_path.exists())

    def test_scanner_without_table_metadata_is_not_scored_as_empty_models(self):
        spark = support.FakeSpark({"model_inventory": [inventory_row(i) for i in range(3)]})
        with self.assertRaises(RuntimeError) as caught:
            self.run_nb01(spark, self.handler(scanner_workspaces(with_tables=False)))
        self.assertIn("no table, column or measure metadata", str(caught.exception))
        self.assertEqual(spark.written("model_inventory"), [])
        self.assertEqual(len(spark.tables["model_inventory"]), 3)
        self.assert_failed(spark, "scan", run_id=support.read_json(self.status_path)["runId"])

    def test_shrinking_inventory_fails_unless_allowed(self):
        previous = [inventory_row(i) for i in range(20)]
        spark = support.FakeSpark({"model_inventory": previous})
        with self.assertRaises(RuntimeError) as caught:
            self.run_nb01(spark, self.handler(scanner_workspaces()))
        self.assertIn("ALLOW_SHRINK=true", str(caught.exception))
        self.assertEqual(spark.written("model_inventory"), [])
        self.assertEqual(len(spark.tables["model_inventory"]), 20)
        self.assert_failed(spark, "scan", run_id=support.read_json(self.status_path)["runId"])

        os.environ["ALLOW_SHRINK"] = "true"
        spark_allowed = support.FakeSpark({"model_inventory": previous})
        self.run_nb01(spark_allowed, self.handler(scanner_workspaces()))
        self.assertEqual(len(spark_allowed.tables["model_inventory"]), len(FIXTURES))

    def test_failed_enrichment_calls_do_not_fail_the_run_but_are_noted(self):
        spark = support.FakeSpark()
        self.run_nb01(spark, self.handler(scanner_workspaces(), dataset_details_fail=True))
        self.assertIn("dataset details unavailable for", spark.tables["scan_runs"][0]["notes"])


class UsageTests(NotebookCase):
    def seed(self):
        self.seed_run_state()
        self.seed_portfolio()
        return support.FakeSpark(
            {
                "model_inventory": [{"workspace_id": "w1", "model_id": "m1"}, {"workspace_id": "w1", "model_id": "m2"}],
                "model_usage": [{"model_id": "m1", "workspace_id": "w1", "view_events": 99}],
                "scan_runs": [{"run_id": RUN_ID, "started_utc": datetime(2026, 1, 2, 3, 4, 5), "status": "InventoryCompleted", "workspaces_scanned": 1, "models_found": 2, "notes": "mode=admin-scanner"}],
            }
        )

    def test_success_replaces_usage_only_after_the_whole_window_was_read(self):
        spark = self.seed()
        seen = []

        def handle(method, url, **kwargs):
            seen.append(url)
            if len(seen) == 1:
                return {"activityEventEntities": [{"DatasetId": "m1", "WorkspaceId": "w1", "Activity": "ViewReport", "UserId": "u1", "CreationTime": "2026-01-01T00:00:00Z"}]}
            return {}

        support.run_notebook("NB_02_Usage.py", self.work, spark, support.HttpScript(handle))
        self.assertEqual(len(seen), 28)
        usage = {row["model_id"]: row for row in spark.tables["model_usage"]}
        self.assertEqual(usage["m1"]["view_events"], 1)
        self.assertEqual(usage["m1"]["distinct_users"], 1)
        self.assertEqual(usage["m2"]["usage_tier"], "Unused")
        self.assertEqual(spark.tables["scan_runs"][0]["status"], "UsageCompleted")
        status = support.read_json(self.status_path)
        self.assertEqual((status["status"], status["stage"]), ("Running", "usage"))

    def test_api_failure_midway_fails_the_run_and_keeps_the_previous_usage(self):
        spark = self.seed()
        calls = []

        def handle(method, url, **kwargs):
            calls.append(url)
            if len(calls) == 4:
                raise RuntimeError("HTTP 429 for activityevents: Bearer secret-token-value")
            return {}

        with self.assertRaises(RuntimeError):
            support.run_notebook("NB_02_Usage.py", self.work, spark, support.HttpScript(handle))

        self.assertEqual(spark.written("model_usage"), [])
        self.assertEqual(spark.tables["model_usage"], [{"model_id": "m1", "workspace_id": "w1", "view_events": 99}])
        self.assert_portfolio_untouched()
        self.assert_failed(spark, "usage")
        self.assertIn("mode=admin-scanner", spark.tables["scan_runs"][0]["notes"])

    def test_missing_run_state_fails_with_a_status_file(self):
        spark = support.FakeSpark()
        with self.assertRaises(RuntimeError) as caught:
            support.run_notebook("NB_02_Usage.py", self.work, spark, support.HttpScript(lambda *a, **k: {}))
        self.assertIn("could not find the current run state", str(caught.exception))
        status = support.read_json(self.status_path)
        self.assertEqual((status["status"], status["stage"], status["runId"]), ("Failed", "usage", None))
        self.assertEqual(spark.written("model_usage"), [])


class QuickScoreTests(NotebookCase):
    def seed(self, corrupt_model=None):
        self.seed_run_state()
        self.seed_portfolio()
        catalog_target = self.work.file("Files/config/rule-catalog.json")
        catalog_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(support.CATALOG_PATH, catalog_target)
        inventory, details = [], []
        for entry in FIXTURES:
            tables = entry["dataset"].get("tables", [])
            inventory.append(
                {
                    "workspace_id": "ws-1",
                    "workspace_name": "Finance",
                    "model_id": entry["id"],
                    "last_refresh_utc": datetime(2026, 1, 1, 6),
                    "last_refresh_status": "Completed",
                    "table_count": len(tables),
                    **entry["inventory"],
                }
            )
            dataset_json = "{not json" if entry["id"] == corrupt_model else json.dumps(entry["dataset"])
            details.append({"run_id": RUN_ID, "workspace_id": "ws-1", "model_id": entry["id"], "dataset_json": dataset_json})
        return support.FakeSpark(
            {
                "model_inventory": inventory,
                "model_scan_detail": details,
                "model_quick_score": [{"model_id": "old", "workspace_id": "ws-1", "score": 1.0}],
                "scan_runs": [{"run_id": RUN_ID, "started_utc": datetime(2026, 1, 2, 3, 4, 5), "status": "UsageCompleted", "workspaces_scanned": 1, "models_found": len(FIXTURES), "notes": "mode=admin-scanner"}],
            }
        )

    def test_success_writes_the_portfolio_last_and_marks_the_run_succeeded(self):
        spark = self.seed()
        support.run_notebook("NB_03_Quick_Score.py", self.work, spark)

        portfolio = support.read_json(self.portfolio_path)
        self.assertTrue(portfolio["generatedAt"].endswith("Z"))
        self.assertEqual(portfolio["runId"], RUN_ID)
        self.assertEqual(len(portfolio["models"]), len(FIXTURES))
        self.assertEqual({model["lastRefresh"]["status"] for model in portfolio["models"]}, {"Completed"})
        self.assertEqual(len(spark.tables["model_quick_score"]), len(FIXTURES))

        status = support.read_json(self.status_path)
        self.assertEqual(status["status"], "Succeeded")
        self.assertEqual(status["stage"], "score")
        self.assertEqual(status["models"], len(FIXTURES))
        self.assertTrue(status["finishedAt"])
        self.assertIsNone(status["error"])
        self.assertEqual(status["runId"], RUN_ID)
        self.assertEqual(spark.tables["scan_runs"][0]["status"], "Succeeded")
        self.assertEqual(self.work.leftovers(), [])

    def test_a_scoring_failure_writes_nothing_and_keeps_the_previous_portfolio(self):
        spark = self.seed(corrupt_model=FIXTURES[1]["id"])
        with self.assertRaises(ValueError):
            support.run_notebook("NB_03_Quick_Score.py", self.work, spark)

        self.assertEqual(spark.written("model_quick_score"), [])
        self.assertEqual(spark.written("scanner_coverage"), [])
        self.assertEqual(spark.tables["model_quick_score"], [{"model_id": "old", "workspace_id": "ws-1", "score": 1.0}])
        self.assert_portfolio_untouched()
        self.assert_failed(spark, "score")

    def test_a_failure_after_the_tables_were_written_still_leaves_the_portfolio_alone(self):
        spark = self.seed()
        real_merge = support._fake_merge_table

        def failing_merge(spark_arg, name, rows, schema, keys):
            if rows and rows[0].get("status") == "Succeeded":
                raise RuntimeError("delta commit conflict")
            return real_merge(spark_arg, name, rows, schema, keys)

        with mock.patch.object(support, "_fake_merge_table", failing_merge):
            with self.assertRaises(RuntimeError):
                support.run_notebook("NB_03_Quick_Score.py", self.work, spark)

        self.assert_portfolio_untouched()
        status = support.read_json(self.status_path)
        self.assertEqual((status["status"], status["stage"]), ("Failed", "score"))
        self.assertIsNone(status["models"])


if __name__ == "__main__":
    unittest.main()
