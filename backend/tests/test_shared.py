"""Unit tests for the pure helpers in backend/notebooks/_shared.py (no Spark, no network).

Run from the repo root:  python -m unittest discover -s backend/tests -p "test_*.py"
"""

import json
import os
import unittest
from datetime import datetime, timezone
from unittest import mock

import support

shared = support.load_shared()


class RedactErrorTests(unittest.TestCase):
    def test_strips_bearer_tokens_and_jwts(self):
        jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbg"
        text = shared.redact_error(f"HTTP 401 for url: Bearer abc.DEF-123_x= and {jwt} done")
        self.assertNotIn("abc.DEF", text)
        self.assertNotIn("eyJhbGci", text)
        self.assertIn("[redacted]", text)

    def test_strips_key_value_secrets(self):
        for raw in ("access_token=abc123", "client_secret: s3cr3t", "Authorization: xyz", "sig=AbCdEf", "password=hunter2"):
            with self.subTest(raw=raw):
                text = shared.redact_error(f"failed with {raw} today")
                self.assertNotIn(raw.split("=")[-1].split(": ")[-1], text)

    def test_single_line_and_capped(self):
        text = shared.redact_error("line one\n\nline   two\t" + "x" * 2000)
        self.assertNotIn("\n", text)
        self.assertLessEqual(len(text), shared.ERROR_MAX_CHARS)
        self.assertTrue(text.endswith("..."))
        self.assertTrue(text.startswith("line one line two"))

    def test_custom_limit_and_none(self):
        self.assertLessEqual(len(shared.redact_error("y" * 100, 20)), 20)
        self.assertEqual(shared.redact_error(None), "")


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.work = support.Workdir()
        self.addCleanup(self.work.cleanup)

    def test_writes_and_overwrites_without_leftovers(self):
        path = str(self.work.file("Files/app/portfolio.json"))
        shared.write_json(path, {"generatedAt": "a"})
        shared.write_json(path, {"generatedAt": "b"})
        self.assertEqual(support.read_json(path), {"generatedAt": "b"})
        self.assertEqual(self.work.leftovers(), [])

    def test_failed_write_keeps_previous_content_and_removes_temp(self):
        path = str(self.work.file("Files/app/portfolio.json"))
        shared.write_json(path, {"ok": True})
        with mock.patch("os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                shared.write_json(path, {"ok": False})
        self.assertEqual(support.read_json(path), {"ok": True})
        self.assertEqual(self.work.leftovers(), [])

    def test_unserialisable_content_never_touches_target(self):
        path = str(self.work.file("current_run.json"))
        shared.write_json(path, {"ok": 1})
        with self.assertRaises(TypeError):
            shared.write_json(path, {"bad": object()})
        self.assertEqual(support.read_json(path), {"ok": 1})
        self.assertEqual(self.work.leftovers(), [])


class InventoryShrinkTests(unittest.TestCase):
    def test_small_previous_inventory_is_never_guarded(self):
        shared.check_inventory_shrink(1, 10)
        shared.check_inventory_shrink(1, 3)

    def test_first_run_passes(self):
        shared.check_inventory_shrink(0, 0)
        shared.check_inventory_shrink(3, 0)

    def test_half_or_more_passes(self):
        shared.check_inventory_shrink(50, 100)
        shared.check_inventory_shrink(120, 100)

    def test_below_half_fails_with_actionable_message(self):
        with self.assertRaises(RuntimeError) as caught:
            shared.check_inventory_shrink(49, 100)
        message = str(caught.exception)
        self.assertIn("49", message)
        self.assertIn("100", message)
        self.assertIn("ALLOW_SHRINK=true", message)
        self.assertIn("left untouched", message)

    def test_empty_result_after_a_real_inventory_fails(self):
        with self.assertRaises(RuntimeError):
            shared.check_inventory_shrink(0, 4)

    def test_allow_flag_accepts_the_drop(self):
        shared.check_inventory_shrink(1, 100, allow=True)

    def test_truthy_parsing(self):
        for value in ("true", "TRUE", " yes ", "1", "y"):
            self.assertTrue(shared.truthy(value), value)
        for value in ("", None, "false", "0", "no", "maybe"):
            self.assertFalse(shared.truthy(value), value)


class ScanMetadataTests(unittest.TestCase):
    def test_flags_models_without_any_tables(self):
        problem = shared.scan_metadata_problem([{"datasets": [{"id": "a", "tables": []}, {"id": "b"}]}])
        self.assertIn("2 semantic model(s)", problem)

    def test_accepts_when_any_model_has_tables(self):
        workspaces = [{"datasets": [{"id": "a", "tables": []}, {"id": "b", "tables": [{"name": "T"}]}]}]
        self.assertIsNone(shared.scan_metadata_problem(workspaces))

    def test_no_models_is_not_a_metadata_problem(self):
        self.assertIsNone(shared.scan_metadata_problem([{"datasets": []}, {}]))


class StripUserListsTests(unittest.TestCase):
    def test_removes_user_lists_at_any_depth(self):
        payload = {
            "workspaces": [
                {
                    "id": "w",
                    "users": [{"emailAddress": "a@contoso.com"}],
                    "datasets": [
                        {"id": "d", "name": "Sales", "users": [{"emailAddress": "b@contoso.com"}], "datasetUserAccessRight": "x"},
                        {"id": "e", "tables": [{"name": "T", "Users": []}]},
                    ],
                    "reports": [{"id": "r", "reportUsers": [{"emailAddress": "c@contoso.com"}]}],
                }
            ]
        }
        cleaned = json.dumps(shared.strip_user_lists(payload))
        self.assertNotIn("contoso.com", cleaned)
        self.assertNotIn('"users"', cleaned.lower())
        self.assertIn('"Sales"', cleaned)
        self.assertIn('"datasetUserAccessRight"', cleaned)

    def test_does_not_mutate_the_input(self):
        payload = {"users": [1], "keep": [{"users": [2], "x": 1}]}
        shared.strip_user_lists(payload)
        self.assertEqual(payload, {"users": [1], "keep": [{"users": [2], "x": 1}]})


class RunStatusDocumentTests(unittest.TestCase):
    def test_contract_shape(self):
        started = datetime(2026, 1, 2, 3, 4, 5)
        finished = datetime(2026, 1, 2, 3, 9, 5, tzinfo=timezone.utc)
        doc = shared.run_status_document("scan-1", "Succeeded", "score", started, finished, None, 12)
        self.assertEqual(
            doc,
            {
                "runId": "scan-1",
                "status": "Succeeded",
                "stage": "score",
                "startedAt": "2026-01-02T03:04:05Z",
                "finishedAt": "2026-01-02T03:09:05Z",
                "error": None,
                "models": 12,
            },
        )

    def test_running_has_no_finish_error_or_models(self):
        doc = shared.run_status_document("scan-1", "Running", "scan", datetime(2026, 1, 2))
        self.assertIsNone(doc["finishedAt"])
        self.assertIsNone(doc["error"])
        self.assertIsNone(doc["models"])

    def test_error_is_redacted_and_capped(self):
        doc = shared.run_status_document("r", "Failed", "usage", datetime(2026, 1, 2), datetime(2026, 1, 2), "Bearer abc123 " + "z" * 900, None)
        self.assertNotIn("abc123", doc["error"])
        self.assertLessEqual(len(doc["error"]), 500)

    def test_zero_models_is_kept_as_zero(self):
        self.assertEqual(shared.run_status_document("r", "Succeeded", "score", datetime(2026, 1, 2), models=0)["models"], 0)

    def test_naive_utc_conversion(self):
        self.assertEqual(shared.to_naive_utc("2026-01-02T03:04:05Z"), datetime(2026, 1, 2, 3, 4, 5))
        self.assertEqual(shared.to_naive_utc("2026-01-02T05:04:05+02:00"), datetime(2026, 1, 2, 3, 4, 5))
        self.assertEqual(shared.to_naive_utc(datetime(2026, 1, 2)), datetime(2026, 1, 2))
        self.assertIsNone(shared.to_naive_utc(None))


class RecordFailureTests(unittest.TestCase):
    def setUp(self):
        self.work = support.Workdir()
        self.addCleanup(self.work.cleanup)
        self.status_path = str(self.work.file("Files/app/run_status.json"))
        self.spark = support.FakeSpark(
            {"scan_runs": [{"run_id": "scan-1", "started_utc": datetime(2026, 1, 2), "status": "InventoryCompleted", "workspaces_scanned": 3, "models_found": 9, "notes": "mode=admin-scanner"}]}
        )
        patcher = mock.patch.multiple(shared, merge_table=support._fake_merge_table, table_exists=support._fake_table_exists)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_marks_scan_runs_failed_and_writes_status_file(self):
        message = shared.record_failure(
            self.spark, "scan-1", datetime(2026, 1, 2), "usage", RuntimeError("HTTP 403: Bearer secret-token-value"), None, self.status_path
        )
        row = self.spark.tables["scan_runs"][0]
        self.assertEqual(row["status"], "Failed")
        self.assertIsNotNone(row["finished_utc"])
        self.assertEqual(row["workspaces_scanned"], 3)
        self.assertEqual(row["models_found"], 9)
        self.assertIn("mode=admin-scanner", row["notes"])
        self.assertIn("FAILED: RuntimeError", row["notes"])
        self.assertNotIn("secret-token-value", row["notes"])

        status = support.read_json(self.status_path)
        self.assertEqual(status["status"], "Failed")
        self.assertEqual(status["stage"], "usage")
        self.assertEqual(status["runId"], "scan-1")
        self.assertTrue(status["finishedAt"].endswith("Z"))
        self.assertNotIn("secret-token-value", status["error"])
        self.assertEqual(status["error"], message)
        self.assertEqual(self.work.leftovers(), [])

    def test_without_a_run_id_only_the_status_file_is_written(self):
        shared.record_failure(self.spark, None, None, "score", ValueError("no run"), None, self.status_path)
        self.assertEqual(self.spark.tables["scan_runs"][0]["status"], "InventoryCompleted")
        status = support.read_json(self.status_path)
        self.assertIsNone(status["runId"])
        self.assertEqual(status["status"], "Failed")
        self.assertEqual(status["stage"], "score")

    def test_never_raises_when_the_recording_itself_fails(self):
        with mock.patch.object(shared, "merge_table", side_effect=RuntimeError("delta unavailable")):
            with mock.patch.object(shared, "write_json", side_effect=OSError("mount unavailable")):
                message = shared.record_failure(self.spark, "scan-1", datetime(2026, 1, 2), "scan", RuntimeError("boom"), None, self.status_path)
        self.assertIn("boom", message)


class PortfolioTests(unittest.TestCase):
    def inventory(self, **overrides):
        row = {
            "workspace_id": "w1",
            "workspace_name": "Finance",
            "model_id": "m1",
            "model_name": "Sales",
            "configured_by": "a@contoso.com",
            "created_date": datetime(2025, 1, 1),
            "storage_mode": "Import",
            "is_refreshable": True,
            "last_refresh_utc": datetime(2026, 1, 1, 6, 0, 0),
            "last_refresh_status": "Failed",
            "report_count": 2,
            "table_count": 4,
            "measure_count": 6,
        }
        row.update(overrides)
        return row

    def build(self, inventory, detail=True, usage=None):
        score_rows = [{"workspace_id": "w1", "model_id": "m1", "score": 61.5, "tier": "Needs work", "categories_json": json.dumps([{"id": "FND", "score": 70}])}]
        details = {("w1", "m1"): {}} if detail else {}
        usage_by_model = {("w1", "m1"): usage} if usage else {}
        return shared.build_portfolio("scan-1", "1.1.0", [inventory], score_rows, usage_by_model, details)

    def test_keeps_the_generated_at_field_and_run_metadata(self):
        portfolio = self.build(self.inventory())
        self.assertTrue(portfolio["generatedAt"].endswith("Z"))
        self.assertEqual(portfolio["runId"], "scan-1")
        self.assertEqual(portfolio["catalogVersion"], "1.1.0")

    def test_last_refresh_reports_the_collected_status_not_a_constant(self):
        model = self.build(self.inventory())["models"][0]
        self.assertEqual(model["lastRefresh"], {"status": "Failed", "endTime": "2026-01-01T06:00:00Z"})

    def test_missing_refresh_status_is_unknown_not_completed(self):
        model = self.build(self.inventory(last_refresh_status=None))["models"][0]
        self.assertEqual(model["lastRefresh"]["status"], "Unknown")

    def test_no_refresh_at_all_is_null(self):
        self.assertIsNone(self.build(self.inventory(last_refresh_utc=None, last_refresh_status=None))["models"][0]["lastRefresh"])

    def test_usage_keeps_the_views30d_name(self):
        usage = {"view_events": 40, "distinct_users": 5, "last_activity_utc": datetime(2026, 1, 3)}
        model = self.build(self.inventory(), usage=usage)["models"][0]
        self.assertEqual(model["usage"]["views30d"], 40)
        self.assertEqual(model["usage"]["uniqueUsers30d"], 5)
        self.assertEqual(model["usage"]["reportsCount"], 2)
        self.assertEqual(model["usage"]["lastActivity"], "2026-01-03T00:00:00Z")

    def test_scan_error_is_set_when_no_table_metadata_came_back(self):
        self.assertIsNone(self.build(self.inventory())["models"][0]["scanError"])
        self.assertIn("no table metadata", self.build(self.inventory(table_count=0))["models"][0]["scanError"])
        self.assertIn("could not be read", self.build(self.inventory(), detail=False)["models"][0]["scanError"])

    def test_quick_score_categories_are_flattened(self):
        self.assertEqual(self.build(self.inventory())["models"][0]["quickScore"], {"score": 61.5, "tier": "Needs work", "categories": {"FND": 70}})


class DescriptionMirrorTests(unittest.TestCase):
    def test_rejections_and_acceptance(self):
        cases = [
            ("Customer", "TBD item here", "placeholder"),
            ("Customer Name", "Name of each customer", "restates-name"),
            ("Net Sales Amount", "Net amount of sales", "restates-name"),
            ("Customer", "Short text", "short"),
            ("Customer", "The legal entity that buys products, identified by tax number.", None),
        ]
        for name, text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(shared.description_problem(name, text), expected)
                self.assertEqual(shared.is_informative_description(name, text), expected is None)

    def test_duplicates_across_five_objects_are_rejected(self):
        text = "Value recorded for the financial period under review."
        self.assertIsNone(shared.description_problem("Amount", text, duplicate_count=4))
        self.assertEqual(shared.description_problem("Amount", text, duplicate_count=5), "duplicate")


if __name__ == "__main__":
    unittest.main()
