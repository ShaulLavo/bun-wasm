#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location("suite", Path(__file__).with_name("bun-suite.py"))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
report_spec = importlib.util.spec_from_file_location("suite_report", Path(__file__).with_name("bun-suite-report.py"))
report = importlib.util.module_from_spec(report_spec)
report_spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def test_footer_overrides_compressed_repeated_lines(self):
        result = suite.parse_output("(pass) repeated\n[repeated 99 times]\n(fail) broken [2ms]\n 100 pass\n 1 fail\nRan 101 tests across 1 file. [3ms]\n")
        self.assertEqual(result["counts"]["pass"], 100)
        self.assertEqual(result["failing_tests"], ["broken"])
        self.assertTrue(result["complete"])

    def test_partial_timeout_keeps_observed_counts(self):
        result = suite.parse_output("(pass) completed\n(fail) failed\nerror: bad value\n")
        self.assertEqual(result["counts"]["pass"], 1)
        self.assertEqual(result["counts"]["fail"], 1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["first_errors"], ["error: bad value"])

    def test_import_failure_is_distinct_from_a_test_failure(self):
        result = suite.parse_output("# Unhandled error between tests\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file. [1ms]\n")
        self.assertEqual(result["counts"]["errors"], 1)
        self.assertEqual(result["failing_tests"], [])

    def test_resume_rejects_changed_provenance(self):
        with tempfile.TemporaryDirectory(prefix="bun-wasm-bun-suite-unit-", dir="/work/tmp") as temporary:
            output = Path(temporary) / "results.json"
            output.write_text(json.dumps({"provenance": {"wasm": "old"}, "results": []}))
            opts = types.SimpleNamespace(output=output, resume=True)
            with self.assertRaisesRegex(SystemExit, "Resume refused"):
                suite.load_results(opts, {"wasm": "new"})

    def test_classification_uses_error_not_unrelated_source_context(self):
        record = {"file": "bundler/cli.test.ts", "first_errors": ["error: Bun.spawn is not supported: no processes"], "excerpt": "describe.concurrent('build', callback)"}
        self.assertEqual(report.classify(record, "", {})[0], "b")

    def test_engine_difference_requires_a_fully_passing_file(self):
        record = {"file": "js/node/assertion.test.ts", "first_errors": ["error: expect(received).toBe(expected)"], "excerpt": "", "timed_out": False}
        other = {"browser": {record["file"]: {"fully_passing": False}}}
        self.assertNotEqual(report.classify(record, "", other)[0], "f")
        other["browser"][record["file"]]["fully_passing"] = True
        self.assertEqual(report.classify(record, "", other)[0], "f")


if __name__ == "__main__":
    unittest.main()
