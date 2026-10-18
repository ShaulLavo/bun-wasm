"""Run bounded OS short writes without limiting the parent harness's files."""
import argparse
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--engine', choices=['quickjs', 'jsc', 'browser', 'node'], required=True)
parser.add_argument('--wasm', type=Path)
args = parser.parse_args()
fixture = ROOT / 'tests/fixtures/fs-writev-partial'

def limit_file():
    signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024, 1024))

with tempfile.TemporaryDirectory(prefix='bun-wasm-next-review-partial-', dir='/work/tmp') as directory:
    work = Path(directory)
    shutil.copyfile(fixture / 'index.mjs', work / 'index.mjs')
    if args.engine == 'node':
        command = ['node', '--no-warnings', str(work / 'index.mjs')]
    elif args.engine == 'browser':
        command = ['node', '--no-warnings', str(ROOT / 'web/scripts/node-host.mjs'), '--wasm', str(args.wasm.resolve()), '--dir', directory + '::/', '--env', 'PWD=/', '--', 'run', '/index.mjs']
    else:
        launcher = os.environ.get("BUN_WASM_LAUNCHER", str(Path(os.environ.get("CARGO_TARGET_DIR", "/work/tmp/bun-wasm-target")) / "release/bun-wasm"))
        command = [launcher, "--wasm", str(args.wasm.resolve()), "--engine", f"{args.engine}={args.wasm.resolve()}", "--env", f"PATH=/opt/bun/{args.engine}/bin:/bin:/usr/bin", "--dir", directory + "::/", "--env", "PWD=/", "--", "run", "/index.mjs"]
    # RLIMIT_FSIZE also applies to Wasmtime's compiled artifacts and COW memfd.
    result = subprocess.run(command, cwd=work, text=True, capture_output=True, timeout=90, preexec_fn=limit_file, env=dict(os.environ, BUN_WASM_CACHE_DIR="off", BUN_WASM_MEMORY_INIT_COW="0"))
    expected = (fixture / 'expected.txt').read_text()
    if result.returncode or result.stdout != expected or result.stderr:
        print('FAIL fs-writev-partial', args.engine, 'exit', result.returncode)
        print(result.stdout, end='')
        print(result.stderr, end='')
        raise SystemExit(1)
    print('PASS fs-writev-partial', args.engine, '(9 short-write and cursor cases)')
