#!/usr/bin/env python3
import importlib.util
import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("suite", Path(__file__).with_name("bun-suite.py"))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
report_spec = importlib.util.spec_from_file_location("suite_report", Path(__file__).with_name("bun-suite-report.py"))
report = importlib.util.module_from_spec(report_spec)
report_spec.loader.exec_module(report)


@unittest.skipUnless(shutil.which("node"), "Node required for installed-package provenance")
class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="bun-wasm-provenance-unit-", dir="/work/tmp" if Path("/work/tmp").is_dir() else None)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "consumer"
        self.package = Path(temporary.name) / "cache.with.dots/runtime.git@0123456789"
        self.pin = "git+https://example.invalid/runtime.git#" + "a" * 40
        self.files = {
            "core/index.ts": "export const core = 1;\n",
            "core/memory-views.js": "export const memoryViews = 1;\n",
            "fs/backend.ts": "export const backend = 1;\n",
            "proc/identity.ts": "export const identity = 1;\n",
            "interrupt/index.ts": "export const interrupt = 1;\n",
            "browser/worker.ts": "export const worker = 1;\n",
            "dist/core/index.js": "export const core = 1;\n",
            "dist/fs/backend.js": "export const backend = 1;\n",
            "dist/fallback.js": "export const fallback = 1;\n",
            "tests/ignored.test.ts": "test fixture\n",
            "node_modules/ignored/index.js": "dependency fixture\n",
            "README.md": "documentation\n",
        }
        for name, text in self.files.items():
            path = self.package / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        (self.package / "package.json").write_text(json.dumps({
            "name": "waffle", "version": "0.0.19", "type": "module",
            "exports": {"./core": {"bun": "./core/index.ts", "import": "./dist/core/index.js", "default": "./dist/fallback.js"}},
        }))
        installed = self.root / "web/node_modules/waffle"
        installed.parent.mkdir(parents=True)
        installed.symlink_to(self.package, target_is_directory=True)
        (self.root / "web/package.json").write_text(json.dumps({"type": "module", "dependencies": {"waffle": self.pin}}))
        (self.root / "web/bun.lock").write_text("consumer lock and exact revision\n")
        for name in ("web/scripts/node-host.mjs",) + suite.BROWSER_HOST_SOURCES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("host fixture\n")
        self.wasm = self.root / "fixture.wasm"
        self.wasm.write_bytes(b"wasm fixture")
        self.opts = types.SimpleNamespace(engine="browser", suite=self.root, dependencies=None,
                                          network="host", timeout=1, test_timeout=1, node_parallel=False)
        self.addCleanup(patch.stopall)
        patch.object(suite, "ROOT", self.root).start()
        patch.object(suite, "git", return_value="suite-commit").start()

    def provenance(self):
        return suite.provenance(self.opts, self.wasm)

    def test_browser_provenance_hashes_installed_source_and_node_generated_modules(self):
        meta = self.provenance()
        runtime = meta["runtime_package"]
        self.assertEqual(runtime["name"], "waffle")
        self.assertEqual(runtime["version"], "0.0.19")
        self.assertEqual(runtime["node_entry"], "dist/core/index.js")
        self.assertEqual(runtime["package_sha256"], suite.digest(self.package / "package.json"))
        self.assertEqual(runtime["sources"], {name: suite.digest(self.package / name) for name in self.files if name.startswith(("core/", "fs/", "proc/", "interrupt/", "browser/"))})
        self.assertEqual(runtime["generated"], {name: suite.digest(self.package / name) for name in self.files if name.startswith("dist/")})
        self.assertEqual(runtime["consumer"], {"pin": self.pin, "package_sha256": suite.digest(self.root / "web/package.json"), "lock_sha256": suite.digest(self.root / "web/bun.lock")})
        self.assertEqual(meta["suite_commit"], "suite-commit")
        self.assertEqual(meta["wasm_sha256"], suite.digest(self.wasm))
        self.assertEqual(meta["runner_sha256"], suite.digest(Path(suite.__file__)))
        self.assertEqual(meta["launcher_sha256"], suite.digest(self.root / "web/scripts/node-host.mjs"))
        self.assertEqual(meta["dependencies"], suite.dependency_digest(self.root / "node_modules"))
        self.assertEqual(meta["test_dependencies"], suite.dependency_digest(self.root / "test/node_modules"))
        expected_host_sources = {
            "web/scripts/node-host.ts", "web/scripts/async-context.ts", "web/scripts/node-worker.ts", "web/scripts/node-process.ts", "web/scripts/node-signals.ts",
            "web/scripts/node-spawn.ts", "web/scripts/node-net.mjs", "web/scripts/node-install-net.ts",
            "web/scripts/node-stdio.ts", "web/src/net/trampoline.ts", "web/src/engine-host.js",
            "web/src/promise-reactions.ts", "web/src/native-stream-state.ts", "web/src/native-direct-stream.ts", "web/src/crypto-inputs.js",
            "web/src/crypto-host.js", "web/src/buffer-transfer.ts", "web/src/content-modules.ts",
            "web/src/net/package-fetch.ts",
        }
        self.assertEqual(set(meta["host_sources"]), expected_host_sources)
        for name in expected_host_sources:
            self.assertEqual(meta["host_sources"][name], suite.digest(self.root / name))
        self.assertFalse(any(name.startswith("runtime/") for name in meta["host_sources"]))

    def test_resume_rejects_changes_to_each_runtime_provenance_component(self):
        original = self.provenance()
        output = self.root / "results.json"
        output.write_text(json.dumps({"provenance": original, "results": []}))
        opts = types.SimpleNamespace(output=output, resume=True)
        for path in [self.package / "core/index.ts", self.package / "core/memory-views.js", self.package / "dist/core/index.js", self.package / "dist/fs/backend.js", self.package / "package.json", self.root / "web/package.json", self.root / "web/bun.lock"]:
            with self.subTest(path=path.relative_to(Path(self.root).parent)):
                text = path.read_text()
                path.write_text(text + "\n")
                try:
                    changed = self.provenance()
                    self.assertNotEqual(changed, original)
                    with self.assertRaisesRegex(SystemExit, "Resume refused"):
                        suite.load_results(opts, changed)
                finally:
                    path.write_text(text)

    def test_resume_rejects_changes_to_each_local_host_module(self):
        original = self.provenance()
        output = self.root / "results.json"
        output.write_text(json.dumps({"provenance": original, "results": []}))
        opts = types.SimpleNamespace(output=output, resume=True)
        for name in suite.BROWSER_HOST_SOURCES:
            with self.subTest(module=name):
                path = self.root / name
                text = path.read_text()
                path.write_text(text + "\n")
                try:
                    with self.assertRaisesRegex(SystemExit, "Resume refused"):
                        suite.load_results(opts, self.provenance())
                finally:
                    path.write_text(text)

    def test_helper_only_change_invalidates_browser_resume(self):
        path = self.root / "web/src/native-direct-stream.ts"
        path.write_text("direct helper before\n")
        original = self.provenance()
        output = self.root / "results.json"
        output.write_text(json.dumps({"provenance": original, "results": []}))
        path.write_text("direct helper after\n")
        changed = self.provenance()
        self.assertNotEqual(changed, original)
        self.assertEqual(changed["host_sources"]["web/src/native-direct-stream.ts"], suite.digest(path))
        with self.assertRaisesRegex(SystemExit, "Resume refused"):
            suite.load_results(types.SimpleNamespace(output=output, resume=True), changed)

    def test_missing_local_host_module_refuses_provenance(self):
        for name in suite.BROWSER_HOST_SOURCES:
            with self.subTest(module=name):
                path = self.root / name
                text = path.read_text()
                path.unlink()
                try:
                    with self.assertRaises(FileNotFoundError):
                        self.provenance()
                finally:
                    path.write_text(text)

    def test_ignores_uninstalled_runtime_and_package_test_dependencies(self):
        original = self.provenance()
        source = self.root / "runtime/core/wasi.ts"
        source.parent.mkdir(parents=True)
        source.write_text("not the installed implementation\n")
        for name in ["tests/ignored.test.ts", "node_modules/ignored/index.js", "README.md"]:
            (self.package / name).write_text("not implementation\n")
        self.assertEqual(self.provenance(), original)

    def test_missing_installed_package_refuses_provenance(self):
        (self.root / "web/node_modules/waffle").unlink()
        with self.assertRaisesRegex(RuntimeError, "waffle|installed"):
            self.provenance()

    def test_missing_generated_node_entry_refuses_provenance(self):
        (self.package / "dist/core/index.js").unlink()
        with self.assertRaisesRegex(RuntimeError, "Node|generated"):
            self.provenance()

    def test_node_source_export_refuses_provenance(self):
        metadata = self.package / "package.json"
        data = json.loads(metadata.read_text())
        data["exports"]["./core"]["import"] = "./core/index.ts"
        metadata.write_text(json.dumps(data))
        with self.assertRaisesRegex(RuntimeError, "Node|generated"):
            self.provenance()

    def test_missing_implementation_source_refuses_provenance(self):
        for name in self.files:
            if name.startswith(("core/", "fs/", "proc/", "interrupt/", "browser/")):
                (self.package / name).unlink()
        with self.assertRaisesRegex(RuntimeError, "source"):
            self.provenance()

    def test_missing_consumer_pin_refuses_provenance(self):
        (self.root / "web/package.json").write_text('{"type":"module"}')
        with self.assertRaisesRegex(RuntimeError, "pin"):
            self.provenance()

    def test_consumer_pin_change_invalidates_provenance(self):
        original = self.provenance()
        manifest = self.root / "web/package.json"
        data = json.loads(manifest.read_text())
        data["dependencies"]["waffle"] = "file:../another-runtime"
        manifest.write_text(json.dumps(data))
        self.assertNotEqual(self.provenance(), original)

    def test_missing_consumer_lock_refuses_provenance(self):
        (self.root / "web/bun.lock").unlink()
        with self.assertRaises(FileNotFoundError):
            self.provenance()

    def test_nonbrowser_provenance_does_not_require_runtime_installation(self):
        (self.root / "web/node_modules/waffle").unlink()
        self.opts.engine = "quickjs"
        self.opts.launcher = self.wasm
        meta = self.provenance()
        self.assertEqual(meta["host_sources"], {})
        self.assertEqual(meta["runtime_package"], {})
        self.assertEqual(meta["launcher_sha256"], suite.digest(self.wasm))


class ReportTests(unittest.TestCase):
    def test_bake_alias_resolves_upstream_client_sources(self):
        with tempfile.TemporaryDirectory(prefix="bun-wasm-bake-alias-", dir="/work/tmp") as directory:
            source = Path(directory)
            (source / "test").mkdir()
            target = source / "src/runtime/bake/client/data-view.ts"
            target.parent.mkdir(parents=True)
            target.write_text("export const marker = 'upstream bake client';\n")
            suite.install_aliases(source)
            package = source / "test/node_modules/bake/data-view"
            main = json.loads((package / "package.json").read_text())["main"]
            self.assertEqual((package / main).read_text(), target.read_text())
            self.assertEqual((package / main).resolve().parent, target.parent)

    @unittest.skipUnless(shutil.which("unshare") and shutil.which("ip"), "Linux network namespaces required")
    def test_loopback_namespace_preserves_host_listener(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            code = "import socket; s = socket.socket(); s.bind(('127.0.0.1', " + str(port) + ")); s.listen(); print('private listener')"
            output = subprocess.check_output(suite.loopback_command([sys.executable, "-c", code]), text=True)
            self.assertEqual(output.strip(), "private listener")
            with socket.create_connection(("127.0.0.1", port)):
                connection, _ = listener.accept()
                connection.close()

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
        record = {"file": "bundler/cli.test.ts", "first_errors": ["error: Executable not found in bun-wasm: echo"], "excerpt": "describe.concurrent('build', callback)", "timed_out": False}
        self.assertEqual(report.classify(record, "", {})[0], "b")

    def test_engine_difference_requires_a_fully_passing_file(self):
        record = {"file": "js/node/assertion.test.ts", "first_errors": ["error: expect(received).toBe(expected)"], "excerpt": "", "timed_out": False}
        other = {"browser": {record["file"]: {"fully_passing": False}}}
        self.assertNotEqual(report.classify(record, "", other)[0], "f")
        other["browser"][record["file"]]["fully_passing"] = True
        self.assertEqual(report.classify(record, "", other)[0], "f")


if __name__ == "__main__":
    unittest.main()
