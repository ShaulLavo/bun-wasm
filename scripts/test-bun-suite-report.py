#!/usr/bin/env python3
"""Check first-blocker classification after self-spawn became available."""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("bun-suite-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def record(path, error, excerpt=""):
    return {"file": path, "first_errors": [error], "excerpt": excerpt, "timed_out": False}


class Classification(unittest.TestCase):
    def test_report_updates_guide_and_preserves_short_readme(self):
        counts = {"pass": 1, "fail": 0, "skip": 0, "todo": 0, "errors": 0}
        result = {"file": "example.test.ts", "counts": counts, "exit": 0, "complete": True, "timed_out": False, "fully_passing": True, "first_errors": [], "failing_tests": [], "excerpt": ""}
        runner = Path(__file__).with_name("bun-suite.py")
        data = {"provenance": {"engine": "quickjs", "suite_commit": "fixture", "runner_sha256": hashlib.sha256(runner.read_bytes()).hexdigest()}, "summary": {"files": 1, "fully_passing": 1, "timeouts": 0, "counts": counts}, "results": [result]}
        with tempfile.TemporaryDirectory(prefix="bun-wasm-report-guide-", dir="/work/tmp") as directory:
            output = Path(directory)
            (output / "README.md").write_text("Short entry point.\n")
            source = output / "results.json"
            source.write_text(json.dumps(data))
            subprocess.run([sys.executable, report.__file__, str(source), "--output", str(output), "--runtime-commit", "fixture"], check=True, capture_output=True, text=True)
            self.assertEqual((output / "README.md").read_text(), "Short entry point.\n")
            self.assertIn("1 fully passing", (output / "guide.md").read_text())

    def test_data_url_is_not_an_uninstalled_package(self):
        item = record("js/node/string-module.test.js", "error: Cannot find package 'data:text'")
        self.assertEqual(report.classify(item, "", {})[1], "data URL module loading")

    def test_internal_node_alias_is_not_an_uninstalled_package(self):
        item = record("js/node/stubs.test.js", "error: Cannot find package '_http_agent'")
        self.assertEqual(report.classify(item, "", {})[1], "Node builtin aliases and stub modules")

    def test_generated_resolver_fixture_is_not_an_uninstalled_package(self):
        item = record("js/node/module/module-resolve-filename-paths.test.js", "error: Cannot find package 'test-package'")
        self.assertEqual(report.classify(item, "Module._resolveFilename", {})[0], "d")

    def test_jsx_fixture_requires_its_own_import_source(self):
        item = record("bundler/transpiler/jsx-tsconfig-react-jsx.test.ts", "error: Cannot find package 'react' from '/tmp/jsx-tsconfig_example/m.jsx'")
        self.assertEqual(report.classify(item, "", {})[1], "tsconfig JSX runtime selection and jsxImportSource")

    def test_installed_native_dependency_is_a_platform_limit(self):
        for error in ["error: Cannot find native binding.", "error: Unsupported OS: wasi, architecture: wasm32", 'error: Could not load the "sharp" module using the linuxnull-wasm32 runtime', "error: No native build was found for platform=wasi arch=wasm32", "error: Unsupported architecture on Linux: wasm32"]:
            with self.subTest(error=error):
                self.assertEqual(report.classify(record("example.test.ts", error), "", {})[0], "a")

    def test_live_service_credentials_are_a_replay_limit(self):
        item = record("example.test.ts", "error: Secret not found: TEST_INFO_AZURE_SERVICE_BUS")
        self.assertEqual(report.classify(item, "", {})[0], "a")

    def test_docker_fixture_requires_an_external_executable(self):
        item = record("example.test.ts", "error: A functional `docker` is required in CI for some tests.")
        self.assertEqual(report.classify(item, "", {})[0], "b")

    def test_inspector_first_blocker_is_its_unix_socket(self):
        item = record("cli/inspect/BunFrontendDevServer.test.ts", "error: Unix sockets and TLS sockets are not supported in bun-wasm")
        self.assertEqual(report.classify(item, "", {})[0], "a")

    def test_missing_bare_module_is_a_dependency(self):
        item = record("example.test.ts", "ResolveMessage: Cannot find module '@nestjs/core' from '/bun/test/example.test.ts'")
        self.assertEqual(report.classify(item, "", {})[0], "c")

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

    def test_dependency_warning_does_not_replace_the_first_failure(self):
        item = record("example.test.ts", "[fs-extra-WARN0003] Warning: fs.realpath.native is not a function.")
        item["first_errors"].append("TypeError: cannot read property 'loadSync' of undefined")
        self.assertEqual(report.error_lines(item), ["TypeError: cannot read property 'loadSync' of undefined"])

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
