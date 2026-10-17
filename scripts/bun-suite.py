#!/usr/bin/env python3
"""Run unmodified upstream test files in disposable WASI preopens."""
import argparse
import concurrent.futures
import fnmatch
import hashlib
import json
import os
import queue
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
import tomllib

ROOT = Path(__file__).resolve().parent.parent
TEST_NAME = re.compile(r"(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$", re.I)
MARKER = re.compile(r"^\((pass|fail|skip|todo)\) (.*)$", re.M)
COUNTER = re.compile(r"^ (\d+) (pass|fail|skip|todo|errors?)$", re.M)
STOP = threading.Event()
PROCESSES = set()
LOCK = threading.Lock()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glob", nargs="*", default=["**"], help="paths relative to test/, shell-quoted globs")
    parser.add_argument("--engine", choices=["quickjs", "jsc", "browser"], default="quickjs")
    parser.add_argument("--network", choices=["host", "loopback"], default="host", help="loopback gives each file a private network namespace without external routing")
    parser.add_argument("--jobs", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=15, help="wall seconds per file, excluding copying")
    parser.add_argument("--test-timeout", type=int, default=2000, help="milliseconds per individual test")
    parser.add_argument("--suite", type=Path, default=ROOT / "vendor/bun")
    parser.add_argument("--launcher", type=Path, default=Path(os.environ["CARGO_TARGET_DIR"]) / "release/bun-wasm")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--log-dir", type=Path, help="retain bounded per-file output for diagnosing the full selected census")
    parser.add_argument("--dependencies", type=Path, help="additional installed suite node_modules directory")
    parser.add_argument("--resume", action="store_true", help="reuse finished files with identical provenance")
    parser.add_argument("--rerun", action="store_true", help="with --resume, replace results for the selected files")
    parser.add_argument("--node-parallel", action="store_true", help="include Node test-*.js assertion scripts; report script exits separately from test counts")
    parser.add_argument("--limit", type=int, help="run first N matching files")
    opts = parser.parse_args()
    if opts.jobs < 1 or opts.timeout <= 0 or opts.test_timeout < 1:
        parser.error("jobs and timeouts must be positive")
    if opts.rerun and not opts.resume:
        parser.error("--rerun requires --resume")
    if opts.network == "loopback":
        subprocess.run(loopback_command(["true"]), check=True)
    opts.started = time.monotonic()
    opts.suite = opts.suite.resolve()
    opts.launcher = opts.launcher.resolve()
    if opts.dependencies:
        opts.dependencies = opts.dependencies.resolve()
    opts.output = opts.output or Path(f"/work/tmp/bun-wasm-bun-suite-results/{opts.engine}.json")
    opts.output = opts.output.resolve()
    return opts


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def git(suite, *args):
    return subprocess.check_output(["git", "-C", str(suite), *args], text=True).strip()


def discover(opts):
    paths = git(opts.suite, "ls-files", "test").splitlines()
    paths = [path[5:] for path in paths if TEST_NAME.search(Path(path).name) or (opts.node_parallel and path.startswith("test/js/node/test/parallel/test-") and Path(path).suffix in {".js", ".mjs", ".cjs"}) or (path[5:] in opts.glob and Path(path).suffix in {".js", ".mjs", ".cjs", ".ts"})]
    paths = [path for path in paths if any(fnmatch.fnmatchcase(path, glob) or path.startswith(glob.rstrip("/") + "/") for glob in opts.glob)]
    return sorted(paths)[:opts.limit]


def snapshot(opts, scratch):
    """Only tracked source, plus the already installed upstream dependencies."""
    archive = scratch / "source.tar"
    subprocess.run(["git", "-C", str(opts.suite), "archive", "HEAD", "-o", str(archive)], check=True)
    source = scratch / "source"
    source.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(source, filter="tar")
    archive.unlink()
    deps = opts.suite / "node_modules"
    if deps.exists():
        subprocess.run(["cp", "-aL", "--reflink=auto", str(deps), str(source / "node_modules")], check=True)
    test_deps = opts.dependencies or opts.suite / "test/node_modules"
    if test_deps.exists():
        subprocess.run(["cp", "-aL", "--reflink=auto", str(test_deps), str(source / "test/node_modules")], check=True)
    install_aliases(source)
    git(source, "init", "-q")
    git(source, "config", "gc.auto", "0")
    git(source, "config", "maintenance.auto", "false")
    # Preserve fixture bytes even when upstream .gitattributes names CRLF files.
    (source / ".git/info/attributes").write_text("* -text -filter -ident\n")
    git(source, "add", "-f", ".")
    git(source, "-c", "user.name=Suite snapshot", "-c", "user.email=suite@localhost", "commit", "-qm", "Isolated suite snapshot")
    git(source, "gc", "--prune=now")
    return source


def install_aliases(source):
    # The runtime does not yet read tsconfig paths. These packages only resolve
    # the suite's helper imports; no upstream source or fixture is rewritten.
    test = source / "test"
    modules = test / "node_modules"
    modules.mkdir(exist_ok=True)
    aliases = {"harness": "harness.ts", "node-harness": "js/node/harness.ts", "registry": "packages/registry/test-registry.ts", "mkfifo": "mkfifo.ts", "s3-server": "packages/s3-server/index.ts", "deno:harness": "js/deno/harness.ts"}
    for name, target in aliases.items():
        package = modules / name
        package.mkdir(exist_ok=True)
        (package / "package.json").write_text(json.dumps({"main": "../../" + target}))
    for name in ["_util", "js"]:
        (modules / name).symlink_to("../" + name, target_is_directory=True)


def dependency_digest(deps):
    files = sorted(path for path in deps.rglob("*") if path.is_file()) if deps.exists() else []
    result = hashlib.sha256()
    for path in files:
        result.update(str(path.relative_to(deps)).encode())
        result.update(digest(path).encode())
    return {"files": len(files), "sha256": result.hexdigest()}


def provenance(opts, wasm):
    return {"schema": 1, "engine": opts.engine, "suite_commit": git(opts.suite, "rev-parse", "HEAD"),
            "wasm_sha256": digest(wasm), "runner_sha256": digest(Path(__file__)),
            "launcher_sha256": digest(opts.launcher) if opts.engine != "browser" else digest(ROOT / "web/scripts/node-host.mjs"),
            "host_sources": {path: digest(ROOT / path) for path in ["web/src/engine-host.js", "runtime/core/memory-views.js", "web/scripts/node-net.mjs", "web/scripts/node-stdio.ts", "web/scripts/node-spawn.ts", "web/src/subprocess.ts", "runtime/proc/identity.ts", "runtime/proc/outcome.ts", "web/src/fs.ts", "runtime/fs/memory.ts", "runtime/fs/backend.ts", "runtime/fs/client.ts", "runtime/fs/service.ts", "runtime/fs/protocol.ts", "runtime/fs/index.ts", "runtime/core/wasi.ts", "runtime/core/descriptors.ts", "runtime/core/filesystem.ts", "runtime/core/path.ts", "runtime/core/index.ts", "runtime/package.json"]} if opts.engine == "browser" else {},
            "dependencies": dependency_digest(opts.suite / "node_modules"),
            "test_dependencies": dependency_digest(opts.dependencies or opts.suite / "test/node_modules"),
            "node_parallel": opts.node_parallel, "network": opts.network, "timeout_seconds": opts.timeout, "test_timeout_ms": opts.test_timeout}


def stop_process(proc):
    # This process group was created by us and is not reused until wait().
    if proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()


def interrupt(signum, frame):
    STOP.set()
    with LOCK:
        for proc in tuple(PROCESSES):
            stop_process(proc)


def loopback_command(command):
    return ["unshare", "--user", "--map-root-user", "--net", "sh", "-c", 'ip link set lo up && exec "$@"', "bun-suite"] + command


def is_assertion_script(opts, source, path):
    if not opts.node_parallel or not path.startswith("js/node/test/parallel/"):
        return False
    text = source.read_text()
    return not re.search(r"(?:require\(\s*['\"]node:test['\"]|from\s*['\"]node:test['\"])", text)



def runs_as_script(opts, source, path):
    if opts.node_parallel and path.startswith("js/node/test/parallel/"):
        return is_assertion_script(opts, source, path)
    return not TEST_NAME.search(Path(path).name)


def command(opts, wasm, work, preloads, path):
    dirs = ["--dir", f"{work}/bun::/bun", "--dir", f"{work}/tmp::/tmp"]
    env = {"PWD": "/bun", "HOME": "/tmp", "TMPDIR": "/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin", "CI": "1", "AGENT": "0", "NO_COLOR": "1", "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1", "BUNWASM_TEST": "1"}
    flags = [part for key, value in env.items() for part in ["--env", f"{key}={value}"]]
    script = runs_as_script(opts, work / "bun/test" / path, path)
    tests = ["run", "/bun/test/" + path] if script else ["test", "--timeout", str(opts.test_timeout)]
    if tests[0] == "test":
        tests += [part for preload in preloads for part in ["--preload", "/bun/test/" + preload.removeprefix("./")]]
        tests += ["/bun/test/" + path]
    if opts.engine == "browser":
        return ["node", "--no-warnings", str(ROOT / "web/scripts/node-host.mjs"), "--wasm", str(wasm), "--net"] + dirs + flags + ["--"] + tests
    return [str(opts.launcher), "--wasm", str(wasm)] + dirs + flags + tests


def parse_output(text):
    counts = dict.fromkeys(["pass", "fail", "skip", "todo", "errors"], 0)
    failures = []
    for status, name in MARKER.findall(text):
        counts[status] += 1
        if status == "fail":
            failures.append(re.sub(r" \[[\d.]+m?s\]$", "", name))
    for count, status in COUNTER.findall(text):
        counts["errors" if status.startswith("error") else status] = int(count)
    lines = [line for line in text.splitlines() if line.strip() and not re.match(r"^\((pass|skip|todo)\)", line)]
    errors = [line for line in lines if re.search(r"error:|Error:|Expected:|Received:|not supported|not a function|Cannot find|SyntaxError|trap|panicked|Timed out", line, re.I)]
    return {"counts": counts, "failing_tests": failures, "first_errors": errors[:20], "excerpt": "\n".join(lines[:55])[:10000], "complete": bool(re.search(r"^Ran \d+ tests? across", text, re.M))}


def worker(opts, wasm, source, scratch, preloads, pending, finished):
    with tempfile.TemporaryDirectory(prefix="worker-", dir=scratch) as temporary:
        work = Path(temporary)
        subprocess.run(["cp", "-a", "--reflink=auto", str(source), str(work / "bun")], check=True)
        worker_loop(opts, wasm, work, preloads, pending, finished)


def worker_loop(opts, wasm, work, preloads, pending, finished):
    while not STOP.is_set():
        try:
            path = pending.get_nowait()
        except queue.Empty:
            return
        (work / "tmp").mkdir()
        record = invoke(opts, wasm, work, preloads, path)
        # Reset tracked edits and delete ALL generated files, including ignored
        # files, before reusing this lane. The upstream checkout is never opened.
        git(work / "bun", "reset", "--hard", "-q", "HEAD")
        git(work / "bun", "clean", "-ffdxq")
        shutil.rmtree(work / "tmp")
        if git(work / "bun", "status", "--porcelain"):
            raise RuntimeError("Worker did not return to its clean snapshot")
        finished.put(record)


def invoke(opts, wasm, work, preloads, path):
    started = time.monotonic()
    timed_out = False
    with (work / "output").open("w+b") as output:
        argv = command(opts, wasm, work, preloads, path)
        if opts.network == "loopback":
            argv = loopback_command(argv)
        proc = subprocess.Popen(argv, cwd=work / "bun/test", stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        with LOCK:
            PROCESSES.add(proc)
        try:
            proc.wait(timeout=opts.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            stop_process(proc)
            with LOCK:
                PROCESSES.discard(proc)
        size = output.tell()
        output.seek(0)
        text = output.read(4 * 1024 * 1024).decode("utf-8", errors="replace")
        if size > 4 * 1024 * 1024:
            output.seek(max(0, size - 65536))
            text += "\n[output truncated]\n" + output.read().decode("utf-8", errors="replace")
    if opts.log_dir:
        log = opts.log_dir / (path + ".log")
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(text)
    result = parse_output(text)
    result.update(file=path, exit=proc.returncode, duration_seconds=round(time.monotonic() - started, 3), timed_out=timed_out, output_bytes=size, interrupted=STOP.is_set())
    result["assertion_script"] = is_assertion_script(opts, work / "bun/test" / path, path)
    result["skipped_script"] = result["assertion_script"] and bool(re.search(r"^1\.\.0 # Skipped:", text, re.M))
    result["kind"] = "script" if runs_as_script(opts, work / "bun/test" / path, path) else "test"
    if result["skipped_script"]: result["counts"]["skip"] += 1
    if result["kind"] == "script": result["complete"] = not timed_out and not STOP.is_set()
    result["fully_passing"] = proc.returncode == 0 and result["complete"] and not result["skipped_script"] and result["counts"]["fail"] == 0 and result["counts"]["errors"] == 0 and (result["counts"]["pass"] > 0 or result["kind"] == "script")
    return result


def write_results(opts, meta, records, selected):
    results = sorted(records.values(), key=lambda record: record["file"])
    summary = {"files": len(results), "fully_passing": sum(r["fully_passing"] for r in results), "timeouts": sum(r["timed_out"] for r in results), "counts": {key: sum(r["counts"][key] for r in results) for key in ["pass", "fail", "skip", "todo", "errors"]}}
    data = {"provenance": meta, "selection": opts.glob, "selected_files": len(selected), "wall_seconds": round(time.monotonic() - opts.started, 3), "summary": summary, "results": results}
    temporary = opts.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.replace(opts.output)


def load_results(opts, meta):
    checkpoint = opts.output.with_suffix(".jsonl")
    if not opts.resume:
        if opts.output.exists() or checkpoint.exists():
            raise SystemExit("Output exists; choose a new --output or use --resume")
        return {}
    previous = json.loads(opts.output.read_text())
    if previous["provenance"] != meta:
        raise SystemExit("Resume refused: suite, dependencies, runner, wasm, launcher or timeout changed")
    records = {record["file"]: record for record in previous["results"]}
    if checkpoint.exists():
        for line in checkpoint.read_text().splitlines():
            record = json.loads(line)
            records[record["file"]] = record
    return {path: record for path, record in records.items() if not record["interrupted"]}


def run_workers(opts, wasm, source, scratch, preloads, records, selected):
    pending = queue.Queue()
    finished = queue.Queue()
    for path in selected:
        if path not in records:
            pending.put(path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=opts.jobs) as pool, opts.output.with_suffix(".jsonl").open("a") as checkpoint:
        futures = [pool.submit(worker, opts, wasm, source, scratch, preloads, pending, finished) for _ in range(opts.jobs)]
        while any(not future.done() for future in futures) or not finished.empty():
            drain_record(finished, records, checkpoint, selected)
        for future in futures:
            future.result()


def drain_record(finished, records, checkpoint, selected):
    try:
        record = finished.get(timeout=0.2)
    except queue.Empty:
        return
    records[record["file"]] = record
    checkpoint.write(json.dumps(record) + "\n")
    checkpoint.flush()
    label = "PASS" if record["fully_passing"] else "TIME" if record["timed_out"] else "SKIP" if record.get("skipped_script") else "FAIL"
    print(f"{len(records)}/{len(set(records).union(selected))} {label} {record['file']} {record['counts']}", flush=True)


def main():
    opts = arguments()
    if git(opts.suite, "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("Suite has tracked modifications; commit or restore them first")
    wasm = ROOT / "dist" / {"quickjs": "bun.wasm", "jsc": "bun-jsc.wasm", "browser": "bun-browser.wasm"}[opts.engine]
    opts.output.parent.mkdir(parents=True, exist_ok=True)
    meta = provenance(opts, wasm)
    records = load_results(opts, meta)
    selected = discover(opts)
    if opts.rerun:
        records = {path: record for path, record in records.items() if path not in selected}
    if not selected:
        raise SystemExit("No test files matched")
    config = tomllib.loads((opts.suite / "test/bunfig.toml").read_text())
    preloads = config.get("test", {}).get("preload", [])
    preloads = [preloads] if isinstance(preloads, str) else preloads
    for sig in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, interrupt)
    write_results(opts, meta, records, selected)
    try:
        with tempfile.TemporaryDirectory(prefix="bun-wasm-bun-suite-", dir="/work/tmp") as temporary:
            scratch = Path(temporary)
            source = snapshot(opts, scratch)
            frozen_wasm = scratch / "engine.wasm"
            shutil.copyfile(wasm, frozen_wasm)
            if digest(frozen_wasm) != meta["wasm_sha256"]:
                raise RuntimeError("Wasm changed during suite setup; rerun with a stable artifact")
            run_workers(opts, frozen_wasm, source, scratch, preloads, records, selected)
    finally:
        write_results(opts, meta, records, selected)
    print(f"Results: {opts.output}")
    return 130 if STOP.is_set() else 0


if __name__ == "__main__":
    raise SystemExit(main())
