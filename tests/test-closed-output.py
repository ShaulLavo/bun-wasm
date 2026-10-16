"""Exercise closed-pipe and sustained-output behavior for every wasm engine."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/pipe-closed-output"

parser = argparse.ArgumentParser()
parser.add_argument("--engine", choices=["quickjs", "jsc", "browser"], required=True)
parser.add_argument("--wasm", type=Path, required=True)
args = parser.parse_args()


def command(directory: Path, script: str) -> list[str]:
    if args.engine == "browser":
        return [
            "node", "--no-warnings", str(ROOT / "web/scripts/node-host.mjs"),
            "--wasm", str(args.wasm.resolve()), "--dir", f"{directory}::/",
            "--env", "PWD=/", "--", "run", f"/{script}",
        ]
    launcher = Path(os.environ["CARGO_TARGET_DIR"]) / "release/bun-wasm"
    return [
        str(launcher), "--wasm", str(args.wasm.resolve()), "--dir", f"{directory}::/",
        "--env", "PWD=/", "run", f"/{script}",
    ]


def closed_pipe(directory: Path) -> int:
    producer = subprocess.Popen(
        command(directory, "index.js"), cwd=directory,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    assert producer.stdout is not None
    reader = subprocess.Popen(["head", "-c", "1"], stdin=producer.stdout, stdout=subprocess.DEVNULL)
    producer.stdout.close()
    try:
        reader.wait(timeout=5)
        return producer.wait(timeout=5)
    except subprocess.TimeoutExpired:
        producer.kill()
        producer.wait()
        return 124
    finally:
        reader.kill() if reader.poll() is None else None
        reader.wait()
        if producer.stderr is not None:
            producer.stderr.close()


def sustained_output(directory: Path) -> tuple[int, int, float]:
    started = time.monotonic()
    result = subprocess.run(
        command(directory, "large.js"), cwd=directory,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
    )
    return result.returncode, len(result.stdout), time.monotonic() - started


with tempfile.TemporaryDirectory(prefix="bun-wasm-closed-output-", dir="/work/tmp") as directory:
    work = Path(directory)
    for name in ("index.js", "large.js"):
        (work / name).write_bytes((FIXTURE / name).read_bytes())
    closed_status = closed_pipe(work)
    if closed_status != 1:
        raise SystemExit(f"FAIL pipe-closed-output {args.engine}: closed status {closed_status}, expected 1")
    large_status, large_bytes, large_seconds = sustained_output(work)
    if large_status != 0 or large_bytes != 8 * 1024 * 1024:
        raise SystemExit(
            f"FAIL pipe-closed-output {args.engine}: large status {large_status}, bytes {large_bytes}"
        )
    print(
        f"PASS pipe-closed-output {args.engine}: closed exit 1, large {large_bytes} bytes "
        f"in {large_seconds:.3f}s"
    )
