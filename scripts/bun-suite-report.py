#!/usr/bin/env python3
"""Generate the baseline tables and an evidence index, without changing tests."""
import argparse
import collections
import csv
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
CATEGORIES = {"a": "platform limitation", "b": "missing subprocess capability", "c": "fixable, small", "d": "fixable, big", "e": "not worth the cost", "f": "engine difference"}


def group(path):
    parts = path.split("/")
    return "/".join(parts[:2]) if parts[0] == "js" else parts[0] if len(parts) > 1 else "root"


def failed(record):
    return record["exit"] != 0 or record["timed_out"] or record["counts"]["fail"] > 0 or record["counts"]["errors"] > 0 or not record["complete"]


def error_lines(record):
    # Source code frames may themselves contain strings such as "Cannot find".
    return [line for line in record["first_errors"] if not re.match(r"^\s*\d+\s*\||^\[fs-extra-WARN\d+\] Warning:", line)]


def subprocess_topic(path, source):
    if "install" in path or path.startswith("packages/registry"):
        return "package manager commands and lifecycle scripts"
    if "bundler" in path or "/compile" in path or '"build"' in source:
        return "bundling, compiling, generated program output"
    if "/test/" in path or '"test"' in source:
        return "test runner output, hooks, assertions and exit status"
    if "cli/" in path:
        return "CLI options, environment, cwd and script launching"
    if re.search(r'bunExe\(\)\s*,\s*"(?:install|add|update|pm|outdated|patch)"', source):
        return "package manager commands and lifecycle scripts"
    if re.search(r"signal|beforeExit|SIG[A-Z]|process.exit", source):
        return "process lifecycle, exit and signal handling"
    if re.search(r"serve|fetch|http|socket", path, re.I):
        return "network server/client behavior in a child program"
    return "runtime behavior or regression fixture in a child program"


def classify(record, source, comparisons):
    path = record["file"]
    evidence = next(iter(error_lines(record)), "")
    excerpt = record["excerpt"].split("\n(fail)", 1)[0]
    other_pass = [engine for engine, records in comparisons.items() if path in records and records[path]["fully_passing"]]
    if other_pass:
        return "f", "passes on " + ", ".join(other_pass), "measured"
    if path == "cli/inspect/BunFrontendDevServer.test.ts" and "Unix sockets" in evidence:
        return "a", "inspector fixture requires Unix-domain sockets outside the current host ABI", "error/context"
    # The size checks now pass; the remaining control launches external echo.
    if path == "js/bun/spawn/spawn-large-array-length.test.ts" and record.get("failing_tests", [])[:1] == ["spawn with spoofed array length > Bun.spawnSync still works with normal arrays"]:
        return "b", "external echo executable in normal-array control", "reproduced"
    if "node:test" in evidence and re.search(r"No such built-in|Cannot find", evidence):
        return "d", "Node's test API adapter", "error"
    if "ArrayBufferSink" in evidence:
        return "d", "Bun.ArrayBufferSink implementation", "error"
    if "not a function" in evidence and re.search(r"\.to(?:BeTrue|BeFalse|MatchSnapshot|MatchInlineSnapshot)\(", excerpt):
        return "c", "test runner boolean or snapshot matchers", "error/context"
    if "jscDescribe" in evidence:
        return "e", "private native-engine/compiler instrumentation has no portable equivalent", "error"
    if "callerSourceOrigin" in evidence:
        return "d", "portable caller source tracking used by the bundler test helper", "error"
    if "bun:internal-for-testing" in evidence or re.search(r"export '(?:jscDescribe|describeArray|codeBlock|optimizeNextInvocation|numberOfDFGCompiles|heapSnapshot)'|heapStats\(\)\.(?:objectTypeCounts|protectedObjectTypeCounts)", evidence + "\n" + excerpt):
        return "e", "private native-engine/compiler instrumentation has no portable equivalent", "path/error"
    if re.search(r"(?:export 'semver'|property 'satisfies'.*undefined)", evidence):
        return "c", "Bun.semver public API", "error"
    if re.search(r"Executable not found in bun-wasm|only bun is supported|stdio redirection|Child process IPC|Spawning bun without host|child concurrency limit|at most four bun-wasm", evidence + "\n" + excerpt):
        return "b", subprocess_topic(path, source), "error/context"
    if re.search(r"unknown flag|Module not found \"(?:lint|check|format|install)\"", evidence + "\n" + excerpt):
        return "d", "CLI option or command implementation", "error/context"
    if "Bun.$ is not supported" in evidence:
        return "d", "Bun shell parser and execution", "error"
    if re.search(r"setDefaultTimeout|setSystemTime|\.concurrent|\.serial|toBeOneOf|toBeArrayOfSize|toContainAllKeys", evidence):
        return "c", "test runner helpers or matcher methods", "error/context"
    if re.search(r"export 'exists'|export 'existsSync'", evidence):
        return "c", "Bun's fs/promises.exists extension", "error"
    if 'property must be of type string, got object' in evidence:
        return "c", "boxed String paths from harness.tempDir", "error/context"
    missing = re.search(r"Cannot find (?:package|module) '([^']+)'", evidence)
    specifier = missing[1] if missing else ""
    if specifier.startswith("data:"):
        return "d", "data URL module loading", "error"
    if re.match(r"_(?:http|stream)_", specifier):
        return "d", "Node builtin aliases and stub modules", "error"
    if specifier == "test-package" and "Module._resolveFilename" in source:
        return "d", "Module._resolveFilename options.paths lookup", "error/context"
    if specifier.split("/")[0] == "react" and "/tmp/jsx-tsconfig" in evidence:
        return "d", "tsconfig JSX runtime selection and jsxImportSource", "error/context"
    if "Secret not found:" in evidence:
        return "a", "live external service credentials unavailable in the isolated suite replay", "error/context"
    if "functional `docker` is required" in evidence:
        return "b", "Docker-backed fixture requires an external docker executable", "error/context"
    if re.search(r"Cannot find native binding|Failed to load native binding|No native build was found for platform=wasi|Unsupported OS: wasi|Unsupported architecture on Linux: wasm32|Could not load the .sharp. module using the .*wasm32 runtime|not yet supported by the native Rollup build", evidence):
        return "a", "dependency requires a native addon binding unavailable to the WASI guest", "error"
    if specifier and not specifier.startswith((".", "/", "node:", "bun:")):
        return "c", "uninstalled suite dependency, setup work before API triage", "error"
    if re.search(r"Glob|globSync|glob'", evidence):
        return "d", "glob matching and filesystem traversal APIs", "error"
    if re.search(r"/shell/|/bun-shell|shell-", path):
        return "d", "Bun shell parser and execution", "path/error"
    if re.search(r"no native libraries|single-threaded|no terminal streams|unsupported.*signal|watch.*not supported|dgram.*not supported", evidence, re.I):
        return "a", "native addons, threads, watching or OS-only facilities", "error"
    if path.startswith("napi/") or "/ffi/" in path:
        return "a", "native addons or FFI", "path"
    if re.search(r"Bun\.listen|Bun\.connect", evidence):
        return "d", "Bun TCP socket callbacks, current host ABI already supports TCP", "error"
    if re.search(r"http2\.|node:http2|tls\.|node:tls", evidence):
        return "d", "TLS or HTTP/2", "error"
    if re.search(r"udpSocket|node:dgram|no network access", evidence):
        return "a", "network operations beyond the current host ABI", "error"
    return classify_subsystem(record, source)


def classify_subsystem(record, source):
    path = record["file"]
    text = next(iter(error_lines(record)), "") + "\n" + record["excerpt"].split("\n(fail)", 1)[0]
    subsystems = [(r"/cookie/|Bun\.Cookie", "Bun Cookie APIs"),
                  (r"mock.module", "ES module mocking and loader invalidation"),
                  (r"node:test|test.describe", "Node's test API adapter"),
                  (r"TOML|YAML|JSON[5CL]|/toml|/yaml|/json[5cl]", "data parser/serializer semantics"),
                  (r"S3Client|RedisClient|SQL|/sql/|/valkey/", "database, Redis or S3 clients"),
                  (r"Shell|shell/|bun:\$", "Bun shell parser and execution"),
                  (r"node:stream|stream/|Stream", "Node/Web stream semantics"),
                  (r"http2|tls|HTTPS|certificate", "TLS or HTTP/2"),
                  (r"/crypto|subtle|CryptoKey", "crypto algorithms and WebCrypto"),
                  (r"/bundler|Bun.build|Bun.plugin|plugin", "bundler options, plugins or compiler output"),
                  (r"/http/|/fetch|/net/|serve|WebSocket", "HTTP/server/fetch/WebSocket semantics"),
                  (r"sqlite", "SQLite API compatibility"),
                  (r"/test/|expect\(received\)|jest", "test runner/assertion or runtime semantics"),
                  (r"/fs|filesystem", "filesystem API semantics")]
    for pattern, topic in subsystems:
        if re.search(pattern, text + "\n" + path):
            return "d", topic, "needs reproduction"
    if record["timed_out"]:
        return "d", "timeout, first unblock and rerun without reducing it to an API verdict", "needs reproduction"
    return "d", "unresolved runtime/module semantics, inspect the recorded failure first", "needs reproduction"


def markdown_table(headers, rows):
    return "\n".join(["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"] + ["| " + " | ".join(str(cell).replace("|", "\\|").replace("\n", " ") for cell in row) + " |" for row in rows])


def runner_revision(sha256):
    commits = subprocess.check_output(["git", "-C", str(ROOT), "log", "-30", "--format=%H", "--", "scripts/bun-suite.py"], text=True).splitlines()
    for commit in commits:
        content = subprocess.check_output(["git", "-C", str(ROOT), "show", commit + ":scripts/bun-suite.py"])
        if hashlib.sha256(content).hexdigest() == sha256:
            return commit
    return None


def tables(data):
    by_dir = collections.defaultdict(list)
    for record in data["results"]:
        by_dir[group(record["file"])].append(record)
    rows = []
    for directory, records in sorted(by_dir.items()):
        counts = {key: sum(record["counts"][key] for record in records) for key in ["pass", "fail", "skip", "todo"]}
        total = sum(counts.values())
        rows.append([directory, len(records), sum(record["fully_passing"] for record in records), f"{counts['pass']:,}/{total:,}", counts["skip"], counts["todo"]])
    return markdown_table(["Directory", "Files", "Fully passing", "Observed tests passed/total", "Skipped", "Todo"], rows)


def changes(previous, current):
    before = {r["file"]: r for r in previous["results"]}
    regressions = [r["file"] for r in current["results"] if before.get(r["file"], {}).get("fully_passing") and not r["fully_passing"]]
    new_passes = [r["file"] for r in current["results"] if r["fully_passing"] and not before.get(r["file"], {}).get("fully_passing")]
    return {"regressions": regressions, "new_fully_passing": new_passes,
            "new_timeouts": [r["file"] for r in current["results"] if r["timed_out"] and not before.get(r["file"], {}).get("timed_out")],
            "resolved_timeouts": [r["file"] for r in current["results"] if not r["timed_out"] and before.get(r["file"], {}).get("timed_out")]}


def self_spawn_subset(data):
    records = [r for r in data["results"] if r["file"].startswith(("cli/", "regression/", "js/bun/spawn", "js/node/child_process")) or r["file"] == "bundler/bun-build-api.test.ts"]
    return {"files": len(records), "fully_passing": sum(r["fully_passing"] for r in records),
            "tests_passing": sum(r["counts"]["pass"] for r in records),
            "timeouts": [r["file"] for r in records if r["timed_out"]]}


def progress(output, summary, runtime_commit, measured_date):
    path = output / "progress.json"
    history = json.loads(path.read_text()) if path.exists() else []
    entry = {"date": measured_date, "commit": runtime_commit,
             "fully_passing": summary["summary"]["fully_passing"], "tests_passing": summary["summary"]["counts"]["pass"],
             "timeouts": summary["summary"]["timeouts"], "categories": summary["categories"]}
    history = [item for item in history if item["commit"] != runtime_commit] + [entry]
    path.write_text(json.dumps(history, indent=2) + "\n")
    rows = [[h["date"], h["commit"], h["fully_passing"], h["tests_passing"], h["timeouts"]] + [h["categories"][key] for key in CATEGORIES] for h in history]
    return "## Progress\n\n" + markdown_table(["Date", "Runtime commit", "Files fully passing", "Tests passing", "Timeouts"] + list(CATEGORIES), rows) + "\n\nCategory counts use each run's classifier. The current classifier requires an explicit missing subprocess capability for b; category movement alone is not a compatibility gain.\n"


def investigation_index(data, delta):
    text = "\n\n## Regressions from the previous baseline\n\n"
    regressions = delta.get("regressions", [])
    text += ("\n".join("- `" + path + "`" for path in regressions) if regressions else "No formerly fully passing file fails in this run." if delta else "No previous full run supplied; regression comparison unavailable.") + "\n"
    text += "\n## Timeout index\n\nEvery row has a 15-second wall deadline. A completed report can also come from a child test command; it does not prove that the parent completed. Reproduce with the README command and the exact file path below. See [investigations.md](investigations.md) for longer reruns and diagnoses.\n\n"
    new = set(delta.get("new_timeouts", []))
    rows = [[r["file"], "new" if r["file"] in new else "existing", r["complete"], r["counts"]["pass"], r["failing_tests"][-1] if r["failing_tests"] else "no named failure", next(iter(error_lines(r)), "no error captured")[:180]] for r in data["results"] if r["timed_out"]]
    return text + markdown_table(["File", "Change", "Report observed", "Passes", "Last failure observed", "First error"], rows) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--compare", type=Path, action="append", default=[])
    parser.add_argument("--suite", type=Path, default=ROOT / "vendor/bun")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/bun-test-suite")
    parser.add_argument("--previous", type=Path, help="previous full QuickJS JSON for pass and timeout comparisons")
    parser.add_argument("--date", default=date.today().isoformat(), help="measurement date for the progress table")
    parser.add_argument("--runtime-commit", default=subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip())
    opts = parser.parse_args()
    data = json.loads(opts.results.read_text())
    delta = changes(json.loads(opts.previous.read_text()), data) if opts.previous else {}
    comparisons = {item["provenance"]["engine"]: {r["file"]: r for r in item["results"]} for item in [json.loads(path.read_text()) for path in opts.compare]}
    opts.output.mkdir(parents=True, exist_ok=True)
    assignments = []
    for record in data["results"]:
        if not failed(record):
            continue
        source = (opts.suite / "test" / record["file"]).read_text(errors="replace")
        category, topic, confidence = classify(record, source, comparisons)
        assignments.append({"file": record["file"], "category": category, "topic": topic, "confidence": confidence, "tests_passed": record["counts"]["pass"], "tests_failed": record["counts"]["fail"], "timed_out": record["timed_out"], "test": next(iter(record["failing_tests"]), "<collection/hook/exit; no named failure>"), "error": next(iter(error_lines(record)), "<see JSON excerpt; no error line>").rstrip()})
    with (opts.output / "failures.tsv").open("w") as output:
        writer = csv.DictWriter(output, fieldnames=["file", "category", "topic", "confidence", "tests_passed", "tests_failed", "timed_out", "test", "error"], delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(assignments)
    topics = collections.defaultdict(list)
    for item in assignments:
        topics[(item["category"], item["topic"])].append(item)
    rows = []
    for (category, topic), items in sorted(topics.items()):
        example = items[0]
        rows.append([category, topic, len(items), example["file"], example["test"][:100], example["error"][:180]])
    (opts.output / "triage.md").write_text("# Failure groups\n\nEach row describes the first observed blocker. Subsystem assignments marked 'needs reproduction' are provisional; they do not establish that every test needs the same fix. Full assignments and confidence are in [failures.tsv](failures.tsv).\n\n" + markdown_table(["Category", "First blocker / topic", "Files", "Example file", "Test", "Error"], rows) + investigation_index(data, delta))
    counts = collections.Counter(item["category"] for item in assignments)
    by_file = {record["file"]: record for record in data["results"]}
    category_tests = {key: {"pass": 0, "total": 0} for key in CATEGORIES}
    for item in assignments:
        observed = by_file[item["file"]]["counts"]
        category_tests[item["category"]]["pass"] += observed["pass"]
        category_tests[item["category"]]["total"] += sum(observed[key] for key in ["pass", "fail", "skip", "todo"])
    other_files = sum(not failed(record) and not record["fully_passing"] for record in data["results"])
    summary = {"provenance": data["provenance"], "runner_source_commit": runner_revision(data["provenance"]["runner_sha256"]), "summary": data["summary"], "timeouts_after_report": sum(record["timed_out"] and record["complete"] for record in data["results"]), "wall_seconds": data.get("wall_seconds"), "failing_files": len(assignments), "empty_or_skip_only_files": other_files, "categories": {key: counts[key] for key in CATEGORIES}, "category_tests": category_tests, "comparison": {engine: comparison_summary(data, engine, records) for engine, records in comparisons.items()}}
    summary["self_spawn_subset"] = self_spawn_subset(data)
    summary["runtime_source_commit"] = opts.runtime_commit
    summary["changes_since_previous"] = delta
    summary["comparison_provenance"] = {json.loads(path.read_text())["provenance"]["engine"]: json.loads(path.read_text())["provenance"] for path in opts.compare}
    history = progress(opts.output, summary, opts.runtime_commit, opts.date)
    (opts.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    stats = data["summary"]
    total = sum(stats["counts"][key] for key in ["pass", "fail", "skip", "todo"])
    text = f"## Measured baseline\n\nUpstream `{data['provenance']['suite_commit']}`, engine `{data['provenance']['engine']}`.\n\n{stats['files']:,} files; {stats['fully_passing']:,} fully passing; {stats['counts']['pass']:,}/{total:,} observed tests passing; {stats['timeouts']} file timeouts.\n\n" + tables(data)
    text += "\n\n" + markdown_table(["Category", "Meaning", "Failing files", "Observed tests passed/total"], [[key, name, counts[key], f"{category_tests[key]['pass']:,}/{category_tests[key]['total']:,}"] for key, name in CATEGORIES.items()])
    text += f"\n\n{len(assignments):,} failing files + {stats['fully_passing']:,} fully passing + {other_files} empty/skip-only = {stats['files']:,} files.\n"
    text += "\n\nCategories are mutually exclusive first-blocker assignments. Passing, empty and skip-only files are excluded. 'Needs reproduction' is a conservative big-work bucket, not a claim that every assertion failure needs a subsystem rewrite. No unexecuted tests are counted.\n"
    if comparisons:
        text += "\n" + markdown_table(["Engine", "Compared files", "Fully passing", "Observed passes", "File timeouts", "QuickJS failures passing here", "QuickJS passes failing here"], [[engine, len(records), sum(r["fully_passing"] for r in records.values()), sum(r["counts"]["pass"] for r in records.values()), sum(r["timed_out"] for r in records.values()), summary["comparison"][engine]["quickjs_fail_other_pass"], summary["comparison"][engine]["quickjs_pass_other_fail"]] for engine, records in comparisons.items()]) + "\n"
        for engine, records in comparisons.items():
            text += f"\n### {engine} comparison\n\n" + tables({"results": list(records.values())}) + "\n"
    readme = opts.output / "README.md"
    template = readme.read_text() if readme.exists() else "# Bun's upstream suite\n\n<!-- baseline:start -->\n<!-- baseline:end -->\n"
    template = re.sub(r"<!-- progress:start -->.*?<!-- progress:end -->", "", template, flags=re.S).rstrip() + "\n\n<!-- progress:start -->\n" + history + "<!-- progress:end -->\n"
    readme.write_text(re.sub(r"<!-- baseline:start -->.*?<!-- baseline:end -->", lambda match: "<!-- baseline:start -->\n" + text + "<!-- baseline:end -->", template, flags=re.S))
    print(json.dumps(summary, indent=2))


def comparison_summary(data, engine, records):
    pairs = [(record, records[record["file"]]) for record in data["results"] if record["file"] in records]
    return {"files": len(pairs), "fully_passing": sum(r["fully_passing"] for r in records.values()),
            "timeouts": sum(r["timed_out"] for r in records.values()),
            "timeouts_with_report": sum(r["timed_out"] and r["complete"] for r in records.values()),
            "counts": {key: sum(r["counts"][key] for r in records.values()) for key in ["pass", "fail", "skip", "todo", "errors"]},
            "quickjs_fail_other_pass": sum(failed(a) and b["fully_passing"] for a, b in pairs), "quickjs_pass_other_fail": sum(a["fully_passing"] and failed(b) for a, b in pairs), "different_test_counts": sum(a["counts"] != b["counts"] for a, b in pairs)}


if __name__ == "__main__":
    main()
