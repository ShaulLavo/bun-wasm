#!/usr/bin/env python3
"""Keep stdin open and empty until the guest exits. No EOF may unblock it.

source env.sh && python3 tests/test-empty-stdin.py [--engine quickjs|jsc|browser|spidermonkey|native] [--wasm PATH] [--tier interp|pbl]
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--engine", choices=("quickjs", "jsc", "browser", "spidermonkey", "native"), default="quickjs"
    )
    parser.add_argument("--wasm", type=Path)
    parser.add_argument("--tier", choices=("interp", "pbl"))
    parser.add_argument("--timeout", type=float, default=10)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    fixture = root / "tests/fixtures/fs-empty-read"
    binaries = {
        "quickjs": "bun.wasm", "jsc": "bun-jsc.wasm",
        "browser": "bun-browser.wasm", "native": "unused",
    }
    if args.engine == "spidermonkey" and (args.wasm is None or args.tier is None):
        parser.error("SpiderMonkey requires explicit --wasm CORE and --tier interp|pbl")
    wasm = (args.wasm or root / "dist" / binaries[args.engine]).resolve() if args.engine != "spidermonkey" else args.wasm.resolve()
    launcher = os.environ.get("BUN_WASM_LAUNCHER", str(Path(os.environ.get("CARGO_TARGET_DIR", "/work/tmp/bun-wasm-target")) / "release/bun-wasm"))
    if args.engine == "spidermonkey":
        shell = os.environ.get("BUN_WASM_SHELL")
        env_utility = os.environ.get("BUN_WASM_ENV_UTILITY")
        if not shell or not env_utility or not os.environ.get("BUN_WASM_LAUNCHER"):
            parser.error("SpiderMonkey requires explicit launcher, shell, and env utility inputs")
        command = [launcher, "--wasm", str(wasm), "--engine", f"{args.engine}={wasm}", "--shell", shell, "--env-utility", env_utility, "--env", f"PATH=/opt/bun/{args.engine}/bin:/bin:/usr/bin", "--env", f"BUN_WASM_SPIDERMONKEY_TIER={args.tier}", "--dir", f"{fixture}::/", "--env", "PWD=/", "--", "run", "/index.js"]
    else:
        command = [launcher, "--wasm", str(wasm), "--engine", f"{args.engine}={wasm}", "--env", f"PATH=/opt/bun/{args.engine}/bin:/bin:/usr/bin", "--dir", f"{fixture}::/", "--env", "PWD=/", "--", "run", "/index.js"]
    if args.engine == "native":
        command = ["bun", "run", "index.js"]
    if args.engine == "browser":
        command = [
            "node", str(root / "web/scripts/node-host.mjs"), "--wasm", str(wasm),
            "--dir", f"{fixture}::/", "--", "run", "/index.js",
        ]
    child = subprocess.Popen(
        command, cwd=fixture, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=dict(os.environ, **({"BUN_WASM_SPIDERMONKEY_TIER": args.tier} if args.engine == "spidermonkey" else {})),
    )
    try:
        # communicate() would close stdin and hide the bug.
        child.wait(timeout=args.timeout)
        stdout = child.stdout.read().decode()
        stderr = child.stderr.read().decode()
        expected = (fixture / "expected.txt").read_text()
        if child.returncode != 0 or stdout != expected:
            raise AssertionError(f"exit={child.returncode}\nstdout={stdout!r}\nstderr={stderr}")
        print(f"PASS {args.engine}: empty reads completed while stdin stayed open")
    except subprocess.TimeoutExpired:
        print(f"FAIL {args.engine}: guest blocked on open, empty stdin", file=sys.stderr)
        return 1
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
