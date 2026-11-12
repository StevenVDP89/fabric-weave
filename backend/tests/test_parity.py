"""Parity test: the Python quick scorer (backend/notebooks/_shared.py, used by NB_03) must agree with the
TypeScript engine (app/packages/engine) on the same scanner-shaped models.

The rule *catalog* is shared as data (backend/catalog/rule-catalog.json) but the rule *logic* exists twice, so this
test ties the two together:

  * backend/tests/fixtures/scanner_models.json   scanner-shaped models (sloppy, decent, placeholders, empty)
  * backend/tests/fixtures/golden_ts_scores.json expected per-rule scores, findings, category scores, gates,
                                                  overall score and tier, produced by the TypeScript engine

Only rules both scorers evaluate are compared. The skipped rules are listed explicitly in the golden file
("skipped"): deep-only rules need the full model definition, and INS-001..003 need the AI instructions, which the
scanner does not expose (the TypeScript side nulls them so the overall score is comparable).

TypeScript is the source of truth. After changing rules.ts, names.ts, catalog.ts or the fixtures, regenerate the
golden file and the catalog from the repo root, then re-run this test and `npm test -w @rayfin-app/engine`:

    cd app
    npm run build -w @rayfin-app/engine
    cd ..
    node app/packages/engine/scripts/export-catalog.mjs
    node app/packages/engine/scripts/golden-parity.mjs
    python -m unittest discover -s backend/tests -p "test_*.py"

The Node test (app/packages/engine/test/parity.test.mjs) fails when the TypeScript engine no longer reproduces the
golden file, and this test fails when the Python scorer drifts from it.
"""

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHARED_PATH = ROOT / "backend" / "notebooks" / "_shared.py"
CATALOG_PATH = ROOT / "backend" / "catalog" / "rule-catalog.json"
FIXTURES_PATH = ROOT / "backend" / "tests" / "fixtures" / "scanner_models.json"
GOLDEN_PATH = ROOT / "backend" / "tests" / "fixtures" / "golden_ts_scores.json"
TOLERANCE = 0.001


def load_shared():
    spec = importlib.util.spec_from_file_location("notebook_shared", SHARED_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def finding_keys(findings):
    return sorted(f"{item['objectType']}|{item['objectPath']}|{item['fixKind']}" for item in findings)


class QuickScoreParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shared = load_shared()
        cls.catalog = read_json(CATALOG_PATH)
        cls.fixtures = read_json(FIXTURES_PATH)
        cls.golden = read_json(GOLDEN_PATH)
        cls.results = {
            entry["id"]: cls.shared.score_model(cls.shared.build_model(entry["dataset"], entry["inventory"]), cls.catalog)
            for entry in cls.fixtures
        }

    def assertClose(self, actual, expected, label):
        if expected is None or actual is None:
            self.assertIsNone(actual, f"{label}: expected {expected!r}, got {actual!r}")
            self.assertIsNone(expected, f"{label}: expected {expected!r}, got {actual!r}")
            return
        self.assertLessEqual(abs(float(actual) - float(expected)), TOLERANCE, f"{label}: expected {expected}, got {actual}")

    def test_golden_file_matches_catalog_version(self):
        self.assertEqual(
            self.golden["catalogVersion"],
            self.catalog["version"],
            "golden_ts_scores.json is stale: regenerate it (see the header of this file)",
        )

    def test_fixtures_and_golden_cover_the_same_models(self):
        self.assertEqual(sorted(self.golden["models"]), sorted(entry["id"] for entry in self.fixtures))

    def test_every_catalog_rule_is_compared_or_explicitly_skipped(self):
        catalog_ids = {rule["id"] for rule in self.catalog["rules"]}
        compared = set(self.golden["compared"])
        skipped = set(self.golden["skipped"])
        self.assertFalse(compared & skipped, "a rule cannot be both compared and skipped")
        self.assertEqual(compared | skipped, catalog_ids, "new or removed catalog rules must be compared or listed as skipped")

    def test_python_implements_exactly_the_compared_rules(self):
        self.assertEqual(set(self.shared.RULE_IMPLS), set(self.golden["compared"]))

    def test_skipped_rules_are_not_scored_by_python(self):
        for model_id, result in self.results.items():
            by_id = {row["ruleId"]: row for row in result["rules"]}
            for rule_id in self.golden["skipped"]:
                with self.subTest(model=model_id, rule=rule_id):
                    self.assertIsNone(by_id[rule_id]["score"])

    def test_per_rule_scores_and_findings_match(self):
        for model_id, expected in self.golden["models"].items():
            by_id = {row["ruleId"]: row for row in self.results[model_id]["rules"]}
            for rule_id in self.golden["compared"]:
                with self.subTest(model=model_id, rule=rule_id):
                    self.assertClose(by_id[rule_id]["score"], expected["rules"][rule_id]["score"], f"{model_id} {rule_id} score")
                    self.assertEqual(
                        finding_keys(by_id[rule_id]["findings"]),
                        expected["rules"][rule_id]["findings"],
                        f"{model_id} {rule_id} findings",
                    )

    def test_overall_score_tier_and_gates_match(self):
        for model_id, expected in self.golden["models"].items():
            result = self.results[model_id]
            with self.subTest(model=model_id):
                self.assertClose(result["score"], expected["score"], f"{model_id} score")
                self.assertClose(result["rawScore"], expected["rawScore"], f"{model_id} rawScore")
                self.assertEqual(result["tier"], expected["tier"])
                self.assertEqual({gate["id"]: gate["triggered"] for gate in result["gates"]}, expected["gates"])

    def test_category_scores_match(self):
        for model_id, expected in self.golden["models"].items():
            actual = {category["id"]: category for category in self.results[model_id]["categories"]}
            self.assertEqual(sorted(actual), sorted(expected["categories"]))
            for category_id, values in expected["categories"].items():
                with self.subTest(model=model_id, category=category_id):
                    self.assertClose(actual[category_id]["score"], values["score"], f"{model_id} {category_id} score")
                    self.assertClose(actual[category_id]["points"], values["points"], f"{model_id} {category_id} points")


if __name__ == "__main__":
    unittest.main()
