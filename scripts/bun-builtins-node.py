#!/usr/bin/env python3
"""Run Bun's unchanged Node assertion scripts that the bun:test census does not discover."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    "test-querystring.js",
    "test-querystring-multichar-separator.js",
    "test-querystring-maxKeys-non-finite.js",
    "test-querystring-escape.js",
    "test-punycode.js",
]


def run(command, cwd):
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output = process.communicate(timeout=15)[0]
        return {"exit_code": process.returncode, "timed_out": False, "output": output.decode(errors="replace")[-12000:]}
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output = process.communicate()[0]
        return {"exit_code": process.returncode, "timed_out": True, "output": output.decode(errors="replace")[-12000:]}
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def invoke(opts, wasm, scratch, file):
    path = "test/js/node/test/parallel/" + file
    script = ["run", "/" + path]
    if opts.isolated_common:
        script = ["-e", 'require.cache["/test/js/node/test/common/index.js"] = { exports: {} }; require(' + json.dumps("/" + path) + ');']
    flags = ["--dir", f"{scratch}::/", "--env", "PWD=/", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "BUNWASM_TEST=1"]
    if opts.engine == "browser":
        command = ["node", "--no-warnings", str(ROOT / "web/scripts/node-host.mjs"), "--wasm", str(wasm)] + flags + ["--"] + script
    else:
        launcher = os.environ.get("BUN_WASM_LAUNCHER", str(Path(os.environ.get("CARGO_TARGET_DIR", "/work/tmp/bun-wasm-target")) / "release/bun-wasm"))
        command = [launcher, "--wasm", str(wasm)] + flags + ["--"] + script
    started = time.monotonic()
    record = run(command, scratch)
    record.update({"file": path, "source_sha256": hashlib.sha256((scratch / path).read_bytes()).hexdigest(), "seconds": time.monotonic() - started})
    print(f"{'PASS' if record['exit_code'] == 0 else 'FAIL'} {opts.engine} {file}", flush=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["quickjs", "jsc", "browser"], required=True)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--module", choices=["querystring", "punycode", "all"], default="all")
    parser.add_argument("--isolated-common", action="store_true", help="replace the unused Node common import with an empty fixture module")
    opts = parser.parse_args()
    filename = {"quickjs": "bun.wasm", "jsc": "bun-jsc.wasm", "browser": "bun-browser.wasm"}[opts.engine]
    wasm = (opts.dist / filename).resolve()
    suite = ROOT / "vendor/bun"
    records = []
    with tempfile.TemporaryDirectory(prefix="bun-wasm-builtins-node-", dir="/work/tmp") as temporary:
        scratch = Path(temporary)
        archive = scratch / "source.tar"
        subprocess.run(["git", "-C", str(suite), "archive", "HEAD", "test/js/node/test", "-o", str(archive)], check=True)
        with tarfile.open(archive) as tar:
            tar.extractall(scratch, filter="tar")
        archive.unlink()
        (scratch / "tmp").mkdir()
        files = [file for file in FILES if opts.module == "all" or opts.module in file]
        records = [invoke(opts, wasm, scratch, file) for file in files]
    result = {"engine": opts.engine, "isolated_common": opts.isolated_common, "suite_revision": subprocess.check_output(["git", "-C", str(suite), "rev-parse", "HEAD"], text=True).strip(), "wasm_sha256": hashlib.sha256(wasm.read_bytes()).hexdigest(), "files": len(records), "passing_files": sum(record["exit_code"] == 0 for record in records), "results": records}
    opts.output.parent.mkdir(parents=True, exist_ok=True)
    opts.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: exit(143))
    main()
