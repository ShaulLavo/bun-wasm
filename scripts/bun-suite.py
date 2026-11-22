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
PAIRED_ENGINES = {"quickjs": "quickjs.wasm", "jsc": "jsc-engine.wasm"}
# bash-web's guests behind /bin/sh, /bin/bash and /bin/env. Bun.$, package scripts
# and spawned shells fail with ENOENT without them, as scripts/test.sh registers.
SHELL_GUESTS = {"--shell": "bash-web-shell.wasm", "--env-utility": "bash-web-env.wasm"}
# The upstream snapshot's directory in each lane, which is also its guest path. Not "bun": the
# suite's harness replaces the working directory in printed paths, and "/bun" occurs inside
# upstream paths such as test/js/bun/test. The name also avoids the failure classifier's
# keywords in scripts/bun-suite-report.py ("upstream" would match its "stream/").
SNAPSHOT = "workdir"
GUEST_TESTS = f"/{SNAPSHOT}/test/"
# The Node host refuses shell guests without their build receipt beside them.
SHELL_RECEIPT = "bash-web-guests.json"

# The installed Waffle tree is fingerprinted separately. Include the local Node host and
# its runtime imports so resume cannot reuse results after an adapter or slot change.
BROWSER_HOST_SOURCES = (
    "web/scripts/node-host.ts", "web/scripts/async-context.ts", "web/scripts/node-worker.ts", "web/scripts/node-process.ts", "web/scripts/node-signals.ts",
    "web/scripts/node-spawn.ts", "web/scripts/node-net.mjs", "web/scripts/node-install-net.ts",
    "web/scripts/node-stdio.ts", "web/src/net/trampoline.ts", "web/src/engine-host.js",
    "web/src/promise-reactions.ts", "web/src/native-stream-state.ts", "web/src/native-direct-stream.ts",
    "web/src/buffer-transfer.ts", "web/src/content-modules.ts",
    "web/src/net/package-fetch.ts",
)


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
    aliases = {"harness": "harness.ts", "node-harness": "js/node/harness.ts", "registry": "packages/registry/test-registry.ts", "mkfifo": "mkfifo.ts", "s3-server": "packages/s3-server/index.ts", "deno:harness": "js/deno/harness.ts",
               "bake/data-view": "../src/runtime/bake/client/data-view.ts", "bake/error-serialization.ts": "../src/runtime/bake/client/error-serialization.ts"}
    for name, target in aliases.items():
        package = modules / name
        package.mkdir(parents=True, exist_ok=True)
        (package / "package.json").write_text(json.dumps({"main": os.path.relpath(test / target, package)}))
    for name in ["_util", "js"]:
        (modules / name).symlink_to("../" + name, target_is_directory=True)


def dependency_digest(deps):
    files = sorted(path for path in deps.rglob("*") if path.is_file()) if deps.exists() else []
    result = hashlib.sha256()
    for path in files:
        result.update(str(path.relative_to(deps)).encode())
        result.update(digest(path).encode())
    return {"files": len(files), "sha256": result.hexdigest()}


def runtime_package_provenance():
    """Fingerprint the installed source and the generated modules Node actually loads."""
    consumer = ROOT / "web"
    # Resolve as an ESM import from the consumer, not a require condition or a
    # guessed cache pathname. package.json need not be a public package export.
    resolver = "import { fileURLToPath } from 'node:url'; console.log(fileURLToPath(import.meta.resolve('waffle/core')));"
    try:
        entry = Path(subprocess.check_output(["node", "--input-type=module", "--eval", resolver], cwd=consumer, text=True, stderr=subprocess.PIPE).strip()).resolve()
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError("Cannot resolve installed waffle from the Node host consumer") from error
    for package in entry.parents:
        metadata = package / "package.json"
        if metadata.is_file():
            data = json.loads(metadata.read_text())
            if data.get("name") == "@waffle-os/runtime":
                break
    else:
        raise RuntimeError("Cannot locate installed waffle metadata")
    node_entry = entry.relative_to(package).as_posix()
    if not entry.is_file() or not node_entry.startswith("dist/") or entry.suffix not in {".js", ".mjs", ".cjs"}:
        raise RuntimeError("Installed waffle must export generated dist JavaScript for Node")

    sources = {}
    generated = {}
    for directory, names, files in os.walk(package):
        names[:] = sorted(name for name in names if name not in {"node_modules", ".git", "test", "tests"})
        for name in sorted(files):
            path = Path(directory) / name
            relative = path.relative_to(package)
            if relative.parts[0] == "dist":
                if path.suffix in {".js", ".mjs", ".cjs"}:
                    generated[relative.as_posix()] = digest(path)
            elif path.suffix in {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}:
                sources[relative.as_posix()] = digest(path)
    if not sources:
        raise RuntimeError("Installed waffle implementation source is missing")
    manifest = consumer / "package.json"
    pin = json.loads(manifest.read_text()).get("dependencies", {}).get("waffle")
    if not isinstance(pin, str) or not pin:
        raise RuntimeError("The Node host consumer must pin waffle")
    return {"name": data["name"], "version": data["version"], "node_entry": node_entry,
            "package_sha256": digest(metadata), "sources": sources, "generated": generated,
            "consumer": {"pin": pin, "package_sha256": digest(manifest), "lock_sha256": digest(consumer / "bun.lock")}}


def companions(opts):
    """Guests the launcher loads from beside the engine wasm."""
    paired = [PAIRED_ENGINES[opts.engine]] if opts.engine in PAIRED_ENGINES else []
    return paired + list(SHELL_GUESTS.values()) + [SHELL_RECEIPT]


def provenance(opts, wasm):
    return {"schema": 1, "engine": opts.engine, "suite_commit": git(opts.suite, "rev-parse", "HEAD"),
            "wasm_sha256": digest(wasm),
            "companions_sha256": {name: digest(wasm.with_name(name)) for name in companions(opts)},
            "tools_sha256": digest(wasm.with_name("bun-tools.wasm")) if wasm.with_name("bun-tools.wasm").is_file() else None,
            "runner_sha256": digest(Path(__file__)),
            "launcher_sha256": digest(opts.launcher) if opts.engine != "browser" else digest(ROOT / "web/scripts/node-host.mjs"),
            "host_sources": {path: digest(ROOT / path) for path in BROWSER_HOST_SOURCES} if opts.engine == "browser" else {},
            "runtime_package": runtime_package_provenance() if opts.engine == "browser" else {},
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
    # One root preopen, as scripts/test.sh uses: the shell guest needs "/", and
    # /workdir and /tmp still map to this lane's snapshot and scratch.
    dirs = ["--dir", f"{work}::/"]
    env = {"PWD": f"/{SNAPSHOT}", "HOME": "/tmp", "TMPDIR": "/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin", "CI": "1", "AGENT": "0", "NO_COLOR": "1", "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1", "BUNWASM_TEST": "1"}
    flags = [part for key, value in env.items() for part in ["--env", f"{key}={value}"]]
    flags += [part for flag, name in SHELL_GUESTS.items() for part in [flag, str(wasm.with_name(name))]]
    script = runs_as_script(opts, work / SNAPSHOT / "test" / path, path)
    tests = ["run", GUEST_TESTS + path] if script else ["test", "--timeout", str(opts.test_timeout)]
    if tests[0] == "test":
        tests += [part for preload in preloads for part in ["--preload", GUEST_TESTS + preload.removeprefix("./")]]
        tests += [GUEST_TESTS + path]
    if opts.engine == "browser":
        return ["node", "--no-warnings", str(ROOT / "web/scripts/node-host.mjs"), "--wasm", str(wasm), "--net"] + dirs + flags + ["--"] + tests
    return [str(opts.launcher), "--wasm", str(wasm)] + dirs + flags + tests


FILE_HEADER = re.compile(r"^\S.*(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx):$")
RAN = re.compile(r"^Ran \d+ tests? across")


def own_report(report):
    """The outer run's report, without the nested `bun test` runs a test echoed into it.

    Each invocation runs one file, so its own file header comes first. `Bun.$` echoes a child
    run's report to the parent's stderr as well as capturing it (done-async.test.ts): such a run
    starts at a later file header and ends at its own "Ran N tests across" line. The outer
    run's summary is always the last one.
    """
    lines = report.splitlines(keepends=True)
    ran = [index for index, line in enumerate(lines) if RAN.match(line)]
    if len(ran) < 2:
        return report
    headers = [index for index, line in enumerate(lines) if FILE_HEADER.match(line.rstrip("\n"))]
    kept, skip_until = [], -1
    for index, line in enumerate(lines):
        if index <= skip_until:
            continue
        if headers and index in headers and index != headers[0]:
            end = next((row for row in ran if row > index), None)
            if end is not None and end != ran[-1]:
                skip_until = end
                continue
        kept.append(line)
    return "".join(kept)


def parse_output(report, text=None):
    """Counts and failures from the runner's `report`; error lines and the excerpt from all of `text`."""
    text = report if text is None else text
    report = own_report(report)
    counts = dict.fromkeys(["pass", "fail", "skip", "todo", "errors"], 0)
    failures = []
    for status, name in MARKER.findall(report):
        counts[status] += 1
        if status == "fail":
            failures.append(re.sub(r" \[[\d.]+m?s\]$", "", name))
    for count, status in COUNTER.findall(report):
        counts["errors" if status.startswith("error") else status] = int(count)
    lines = [line for line in text.splitlines() if line.strip() and not re.match(r"^\((pass|skip|todo)\)", line)]
    errors = [line for line in lines if re.search(r"error:|Error:|Expected:|Received:|not supported|not a function|Cannot find|SyntaxError|trap|panicked|Timed out", line, re.I)]
    return {"counts": counts, "failing_tests": failures, "first_errors": errors[:20], "excerpt": "\n".join(lines[:55])[:10000], "complete": bool(re.search(r"^Ran \d+ tests? across", report, re.M))}


def worker(opts, wasm, source, scratch, preloads, pending, finished):
    with tempfile.TemporaryDirectory(prefix="worker-", dir=scratch) as temporary:
        # `work` is the guest's root. The lane's output log sits beside it, out of reach.
        work = Path(temporary) / "root"
        work.mkdir()
        subprocess.run(["cp", "-a", "--reflink=auto", str(source), str(work / SNAPSHOT)], check=True)
        worker_loop(opts, wasm, work, preloads, pending, finished)


def output_log(work):
    return work.parent / "output"


def reset_root(work):
    """Return the guest's root to the clean snapshot alone before the next file."""
    snapshot = work / SNAPSHOT
    # A test that replaced the snapshot with a symlink would point the reset at the link target.
    if snapshot.is_symlink():
        raise RuntimeError("A test replaced the lane's snapshot with a symlink")
    # Reset tracked edits and delete ALL generated files, including ignored
    # files. The upstream checkout is never opened.
    git(snapshot, "reset", "--hard", "-q", "HEAD")
    git(snapshot, "clean", "-ffdxq")
    # Anything a test wrote elsewhere at the root, /tmp included, goes too.
    for entry in work.iterdir():
        if entry.name == SNAPSHOT:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    if git(snapshot, "status", "--porcelain"):
        raise RuntimeError("Worker did not return to its clean snapshot")


def worker_loop(opts, wasm, work, preloads, pending, finished):
    while not STOP.is_set():
        try:
            path = pending.get_nowait()
        except queue.Empty:
            return
        (work / "tmp").mkdir()
        record = invoke(opts, wasm, work, preloads, path)
        reset_root(work)
        finished.put(record)


def read_bounded(stream):
    size = stream.tell()
    stream.seek(0)
    text = stream.read(4 * 1024 * 1024).decode("utf-8", errors="replace")
    if size > 4 * 1024 * 1024:
        stream.seek(max(0, size - 65536))
        text += "\n[output truncated]\n" + stream.read().decode("utf-8", errors="replace")
    return size, text


def invoke(opts, wasm, work, preloads, path):
    started = time.monotonic()
    timed_out = False
    # `bun test` writes its report (the (pass)/(fail) markers and totals) to stderr. The tests'
    # own stdout stays apart, so a test that prints a child `bun test` run's report cannot add
    # that run's results to its own.
    with output_log(work).open("w+b") as output, output_log(work).with_name("stderr").open("w+b") as errors:
        argv = command(opts, wasm, work, preloads, path)
        if opts.network == "loopback":
            argv = loopback_command(argv)
        proc = subprocess.Popen(argv, cwd=work / SNAPSHOT / "test", stdin=subprocess.DEVNULL, stdout=output, stderr=errors, start_new_session=True)
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
        stdout_size, stdout_text = read_bounded(output)
        stderr_size, stderr_text = read_bounded(errors)
    size = stdout_size + stderr_size
    text = stdout_text + ("\n--- stderr ---\n" + stderr_text if stderr_text else "")
    if opts.log_dir:
        log = opts.log_dir / (path + ".log")
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(text)
    # Node assertion scripts report on either stream; bun test reports only on stderr.
    result = parse_output(text if runs_as_script(opts, work / SNAPSHOT / "test" / path, path) else stderr_text, text)
    result.update(file=path, exit=proc.returncode, duration_seconds=round(time.monotonic() - started, 3), timed_out=timed_out, output_bytes=size, interrupted=STOP.is_set())
    result["assertion_script"] = is_assertion_script(opts, work / SNAPSHOT / "test" / path, path)
    result["skipped_script"] = result["assertion_script"] and bool(re.search(r"^1\.\.0 # Skipped:", text, re.M))
    result["kind"] = "script" if runs_as_script(opts, work / SNAPSHOT / "test" / path, path) else "test"
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
            # A split guest loads its paired engine from its own directory; the shell
            # guests are passed by their frozen paths.
            for name, expected in meta["companions_sha256"].items():
                shutil.copyfile(wasm.with_name(name), scratch / name)
                if digest(scratch / name) != expected:
                    raise RuntimeError(f"{name} changed during suite setup; rerun with stable artifacts")
            if meta["tools_sha256"] is not None:
                frozen_tools = scratch / "bun-tools.wasm"
                shutil.copyfile(wasm.with_name("bun-tools.wasm"), frozen_tools)
                if digest(frozen_tools) != meta["tools_sha256"]:
                    raise RuntimeError("Tools changed during suite setup; rerun with stable artifacts")
            run_workers(opts, frozen_wasm, source, scratch, preloads, records, selected)
    finally:
        write_results(opts, meta, records, selected)
    print(f"Results: {opts.output}")
    return 130 if STOP.is_set() else 0


if __name__ == "__main__":
    raise SystemExit(main())
