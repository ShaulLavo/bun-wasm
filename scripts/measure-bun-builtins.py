#!/usr/bin/env python3
"""Compare builtin artifact sizes and empty-program startup on the three engines."""
import argparse
import os
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
ENGINES = {"quickjs": "bun.wasm", "jsc": "bun-jsc.wasm", "browser": "bun-browser.wasm"}


def measure(engine, wasm, code):
    launcher = os.environ.get("BUN_WASM_LAUNCHER", str(Path(os.environ.get("CARGO_TARGET_DIR", "/work/tmp/bun-wasm-target")) / "release/bun-wasm"))
    command = [launcher, "--wasm", str(wasm), "--", "-e", code]
    if engine == "browser":
        command = ["node", "--no-warnings", str(ROOT / "web/scripts/node-host.mjs"), "--wasm", str(wasm), "--", "-e", code]
    elapsed = []
    for _ in range(7):
        start = time.monotonic()
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
        elapsed.append((time.monotonic() - start) * 1000)
    data = wasm.read_bytes()
    return {"bytes": len(data), "gzip9_bytes": len(gzip.compress(data, compresslevel=9, mtime=0)), "sha256": hashlib.sha256(data).hexdigest(), "startup_ms": elapsed, "warm_startup_median_ms": statistics.median(elapsed[1:])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--code", default="0")
    opts = parser.parse_args()
    launcher = Path(os.environ.get("BUN_WASM_LAUNCHER", str(Path(os.environ.get("CARGO_TARGET_DIR", "/work/tmp/bun-wasm-target")) / "release/bun-wasm"))).resolve()
    result = {"code": opts.code, "tools": {"node": subprocess.check_output(["node", "--version"], text=True).strip(), "launcher": str(launcher), "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest()}}
    for label, directory in [("before", opts.before.resolve()), ("after", opts.after.resolve())]:
        result[label] = {engine: measure(engine, directory / filename, opts.code) for engine, filename in ENGINES.items()}
    opts.output.parent.mkdir(parents=True, exist_ok=True)
    opts.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
