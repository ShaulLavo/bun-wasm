#!/usr/bin/env python3
"""Check first-blocker classification after self-spawn became available."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("bun-suite-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def record(path, error, excerpt=""):
    return {"file": path, "first_errors": [error], "excerpt": excerpt, "timed_out": False}


class Classification(unittest.TestCase):
    def test_partial_refresh_preserves_unmeasured_rows(self):
        previous = [{"file": "unmeasured", "error": "retain"}, {"file": "now-passing"}, {"file": "still-failing", "error": "old"}]
        latest = [{"file": "still-failing", "error": "new"}, {"file": "new-failure"}]
        merged = report.merge_measured_failures(previous, latest, ["now-passing", "still-failing", "new-failure"])
        self.assertEqual(merged, [{"file": "new-failure"}, {"file": "still-failing", "error": "new"}, {"file": "unmeasured", "error": "retain"}])

    def test_partial_refresh_rejects_duplicate_selection(self):
        with self.assertRaises(ValueError):
            report.merge_measured_failures([], [], ["duplicate", "duplicate"])

    def test_partial_refresh_rejects_unmeasured_failure(self):
        with self.assertRaises(ValueError):
            report.merge_measured_failures([], [{"file": "outside"}], ["inside"])

    def test_reviewed_large_array_control_requires_external_echo(self):
        item = record("js/bun/spawn/spawn-large-array-length.test.ts", "error: expect(received).toBe(expected)")
        item["failing_tests"] = ["spawn with spoofed array length > Bun.spawnSync still works with normal arrays"]
        self.assertEqual(report.classify(item, "", {})[0], "b")

    def test_spawn_assertion_is_not_an_unsupported_process(self):
        item = record("js/bun/spawn/example.test.ts", "error: expect(received).toBe(expected)")
        self.assertEqual(report.classify(item, 'Bun.spawn([bunExe()]);', {})[0], "d")

    def test_explicit_missing_subprocess_capability(self):
        item = record("cli/example.test.ts", "error: Executable not found in bun-wasm: bash")
        self.assertEqual(report.classify(item, "", {})[0], "b")

    def test_missing_module_precedes_process_path(self):
        item = record("js/node/child_process/example.test.ts", "error: No such built-in module: node:test")
        self.assertEqual(report.classify(item, "", {})[1], "Node's test API adapter")

    def test_cookie_parse_is_not_a_data_parser(self):
        item = record("js/bun/cookie/example.test.ts", "TypeError: cannot read property 'parse' of undefined")
        self.assertNotIn("parser", report.classify(item, "", {})[1])

    def test_numbered_source_lines_are_not_errors(self):
        item = record("example.test.ts", '9 | // Cannot find package')
        item["first_errors"].append("TypeError: not a function")
        self.assertEqual(report.error_lines(item), ["TypeError: not a function"])

    def test_public_jsc_regression_is_not_private_instrumentation(self):
        item = record("js/bun/jsc/example.test.ts", "ReferenceError: ShadowRealm is not defined")
        self.assertEqual(report.classify(item, "", {})[0], "d")

    def test_missing_matcher_precedes_jsc_path(self):
        item = record("js/bun/jsc/example.test.ts", "TypeError: toBeArrayOfSize is not a function")
        self.assertEqual(report.classify(item, "", {})[0], "c")

    def test_port_collision_does_not_claim_host_interference(self):
        item = record("js/bun/http/example.test.ts", "error: Is port 3000 in use?")
        self.assertNotIn("host listener", report.classify(item, "", {})[1])


if __name__ == "__main__":
    unittest.main()
