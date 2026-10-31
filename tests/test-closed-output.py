"""Exercise closed-pipe and sustained-output behavior for every wasm engine."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/pipe-closed-output"

parser = argparse.ArgumentParser()
parser.add_argument("--engine", choices=["quickjs", "jsc", "browser"], required=True)
parser.add_argument("--wasm", type=Path, required=True)
parser.add_argument("--host", choices=["native", "node", "node-control"])
parser.add_argument("--large-only", action="store_true")
parser.add_argument("--batch-only", action="store_true")
args = parser.parse_args()
if args.host == "node-control" and not args.batch_only:
    parser.error("--host node-control requires --batch-only")
host = args.host or ("node" if args.engine == "browser" else "native")


def terminate(*_):
    raise SystemExit(143)


signal.signal(signal.SIGTERM, terminate)


def command(directory: Path, script: str) -> list[str]:
    if host == "node-control":
        return ["node", str(directory / script)]
    if host == "node":
        return [
            "node", "--no-warnings", str(ROOT / "web/scripts/node-host.mjs"),
            "--wasm", str(args.wasm.resolve()), "--dir", f"{directory}::/",
            "--env", "PWD=/", "--", "run", f"/{script}",
        ]
    # The same launcher scripts/test.sh selects.
    launcher = Path(os.environ.get("BUN_WASM_LAUNCHER") or Path(os.environ["CARGO_TARGET_DIR"]) / "release/bun-wasm")
    return [
        str(launcher), "--wasm", str(args.wasm.resolve()),
        "--engine", f"{args.engine}={args.wasm.resolve()}",
        "--env", f"PATH=/opt/bun/{args.engine}/bin:/bin:/usr/bin", "--dir", f"{directory}::/",
        "--env", "PWD=/", "run", f"/{script}",
    ]


def closed_pipe(directory: Path, fd: int, method: str, handled: bool) -> tuple[int, float]:
    arguments = [str(fd), method] + (["handled"] if handled else [])
    producer = subprocess.Popen(
        command(directory, "callback.ts" if method == "callback" else "index.js") + arguments, cwd=directory,
        stdout=subprocess.PIPE if fd == 1 else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    pipe = producer.stdout if fd == 1 else producer.stderr
    assert pipe is not None
    reader = None
    try:
        reader = subprocess.Popen(["head", "-c", "1"], stdin=pipe, stdout=subprocess.PIPE)
        pipe.close()
        first, _ = reader.communicate(timeout=30)
        assert reader.returncode == 0 and first == b"x", "producer did not reach its output loop"
        started = time.monotonic()
        status = producer.wait(timeout=5)
        if fd == 1 and not handled:
            diagnostic = producer.stderr.read()
            assert b"EPIPE" in diagnostic, f"unhandled stdout error was not printed: {diagnostic!r}"
        return status, time.monotonic() - started
    except subprocess.TimeoutExpired:
        producer.kill()
        producer.wait()
        return 124, 5.0
    finally:
        pipe.close()
        if reader is not None and reader.poll() is None:
            reader.kill()
        if reader is not None:
            reader.wait()
            reader.stdout.close()
        if producer.poll() is None:
            producer.kill()
        producer.wait()
        if fd == 1:
            producer.stderr.close()


def sustained_output(directory: Path, fd: int) -> tuple[int, int, float]:
    started = time.monotonic()
    result = subprocess.run(
        command(directory, "large.js") + [str(fd)], cwd=directory,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
    )
    output = result.stdout if fd == 1 else result.stderr
    assert output == b"x" * (8 * 1024 * 1024), f"fd={fd} exit={result.returncode} received {len(output)} bytes, expected 8388608"
    return result.returncode, len(output), time.monotonic() - started


def check_closed(directory: Path, fd: int, method: str, handled: bool):
    status, seconds = closed_pipe(directory, fd, method, handled)
    expected = 42 if handled else 1
    if status != expected:
        raise SystemExit(f"FAIL pipe-closed-output {args.engine}/{host}: fd={fd} {method} handled={handled} exit={status}, expected {expected}")
    print(f"PASS pipe-closed-output {args.engine}/{host}: fd={fd} {method} handled={handled} exit={status} in {seconds:.3f}s")


def check_large(directory: Path, fd: int):
    status, size, seconds = sustained_output(directory, fd)
    if status != 0:
        raise SystemExit(f"FAIL pipe-closed-output {args.engine}/{host}: fd={fd} large exit={status}")
    print(f"PASS pipe-closed-output {args.engine}/{host}: fd={fd} large {size} bytes in {seconds:.3f}s")


def check_batch(directory: Path, fd: int):
    expected = []
    for round in range(2):
        expected.append([f"initial{round}", True, False, None])
        for i in range(3):
            expected.extend([["returned", False], [f"write{round}.{i}", False, False, None]])
        for i in range(3):
            if i == 0:
                expected.append(["error", "EPIPE", -32, "write", True])
            expected.append([f"callback{round}.{i}", False, False, True])
        expected.extend([f"tick{round}.{i}", True, False, None] for i in range(3))
        expected.extend([[f"event{round}", True, False, True], [f"survived{round}", True, False, None]])
    reader, writer = os.pipe()
    os.close(reader)
    started = time.monotonic()
    try:
        result = subprocess.run(
            command(directory, "batch.ts") + [str(fd)], cwd=directory,
            stdout=writer if fd == 1 else subprocess.PIPE,
            stderr=writer if fd == 2 else subprocess.PIPE, timeout=20,
            env=dict(os.environ, NODE_NO_WARNINGS="1"),
        )
    finally:
        os.close(writer)
    output = result.stderr if fd == 1 else result.stdout
    assert result.returncode == 0, f"fd={fd} batch exit={result.returncode}: {output!r}"
    actual = json.loads(output)
    assert actual == expected, f"fd={fd} batch behavior differs: {actual!r} != {expected!r}"
    print(f"PASS pipe-closed-output {args.engine}/{host}: fd={fd} batch callbacks/identity/order/state/survival in {time.monotonic() - started:.3f}s")


with tempfile.TemporaryDirectory(prefix="bun-wasm-closed-output-", dir=tempfile.gettempdir()) as directory:
    work = Path(directory)
    for name in ("index.js", "large.js", "batch.ts", "callback.ts"):
        (work / name).write_bytes((FIXTURE / name).read_bytes())
    batch_failures = 0
    for fd in (1, 2):
        if not args.large_only:
            try:
                check_batch(work, fd)
            except (AssertionError, ValueError, subprocess.TimeoutExpired) as error:
                batch_failures += 1
                print(f"FAIL pipe-closed-output {args.engine}/{host}: {error}")
        if args.batch_only:
            continue
        cases = () if args.large_only else (("stream", False), ("stream", True), ("callback", True), ("console", False), ("fs", False), ("writev", False))
        for method, handled in cases:
            check_closed(work, fd, method, handled)
        check_large(work, fd)
    if batch_failures:
        raise SystemExit(1)
