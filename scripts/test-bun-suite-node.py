#!/usr/bin/env python3
"""Check explicit Node assertion-script discovery without broadening the default census."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("suite", Path(__file__).with_name("bun-suite.py"))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


class NodeSelection(unittest.TestCase):
    def discover(self, enabled, patterns):
        files = "\n".join([
            "test/js/web/streams/example.test.js",
            "test/js/node/test/parallel/test-stream-readable-to-web.mjs",
            "test/js/node/test/parallel/test-stream-writable-from-web.js",
            "test/js/node/test/parallel/helper.js",
            "test/js/node/test/common/index.js",
        ])
        options = SimpleNamespace(suite=Path("unused"), node_parallel=enabled, glob=patterns, limit=None)
        with patch.object(suite, "git", return_value=files):
            return suite.discover(options)

    def test_default_census_is_unchanged(self):
        self.assertEqual(self.discover(False, ["**"]), ["js/web/streams/example.test.js"])

    def test_explicit_node_selection_discovers_scripts(self):
        self.assertEqual(self.discover(True, ["js/node/test/parallel/test-stream-*"]), [
            "js/node/test/parallel/test-stream-readable-to-web.mjs",
            "js/node/test/parallel/test-stream-writable-from-web.js",
        ])

    def test_helper_and_common_files_are_not_tests(self):
        self.assertEqual(len(self.discover(True, ["js/node"])), 2)

    def test_plain_node_scripts_use_the_process_contract(self):
        with tempfile.TemporaryDirectory(prefix="bun-wasm-suite-discovery-", dir="/work/tmp") as directory:
            root = Path(directory)
            path = "js/node/test/parallel/test-stream.js"
            source = root / "bun/test" / path
            source.parent.mkdir(parents=True)
            source.write_text("require('../common'); setTimeout(() => {}, 10);")
            options = SimpleNamespace(node_parallel=True, test_timeout=2000, engine="quickjs", launcher=Path("launcher"))
            result = suite.command(options, Path("engine.wasm"), root, ["preload.ts"], path)
            self.assertEqual(result[-2:], ["run", "/bun/test/" + path])

    def test_registered_node_tests_keep_the_test_runner(self):
        with tempfile.TemporaryDirectory(prefix="bun-wasm-suite-discovery-", dir="/work/tmp") as directory:
            root = Path(directory)
            path = "js/node/test/parallel/test-stream.js"
            source = root / "bun/test" / path
            source.parent.mkdir(parents=True)
            source.write_text("const test = require('node:test'); test('works', () => {});")
            options = SimpleNamespace(node_parallel=True, test_timeout=2000, engine="quickjs", launcher=Path("launcher"))
            result = suite.command(options, Path("engine.wasm"), root, [], path)
            self.assertEqual(result[-4:], ["test", "--timeout", "2000", "/bun/test/" + path])


if __name__ == "__main__":
    unittest.main()
