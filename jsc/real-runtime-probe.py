#!/usr/bin/env python3
"""Generate Bun runtime sources or compile its C++ against an existing WASI JSC.

Source env.sh first. Run compilation inside the documented memory cage.
This probe never patches Bun or JSC. Each Ninja edge records its own diagnostics.
"""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
DIAGNOSTIC = re.compile(r"^(.+?):(\d+):(\d+): (?:fatal )?error: (.+)$", re.M)


def shell(command):
    return shlex.join([str(word) for word in command])


def run_unit(args):
    manifest = json.loads(Path(args.manifest).read_text())
    command = manifest["command"]
    result = subprocess.run(command, cwd=manifest["cwd"], capture_output=True, text=True)
    log = Path(manifest["log"])
    log.write_text(shell(command) + "\n" + result.stdout + result.stderr)
    log.with_suffix(".json").write_text(json.dumps({
        "source": manifest["source"], "exit": result.returncode,
        "command": command, "log": str(log),
    }, indent=2) + "\n")
    return result.returncode


def jsc_flags(jsc):
    entries = json.loads((jsc / "build/jsc/compile_commands.json").read_text())
    entry = next(e for e in entries if e["file"].endswith("/jsc.cpp"))
    words = iter(shlex.split(entry["command"])[1:])
    flags = []
    for word in words:
        if word in ("-c", "-o", "-MF", "-MT"):
            next(words)
            continue
        if word in ("-MD", "-fcolor-diagnostics", "-fdiagnostics-color=always"):
            continue
        flags.append(word)
    return flags


def bun_flags(bun, codegen, includes):
    dirs = [
        "packages", "packages/bun-usockets", "packages/bun-usockets/src",
        "src/jsc/bindings", "src/jsc/bindings/webcore", "src/jsc/bindings/webcrypto",
        "src/jsc/bindings/node/crypto", "src/jsc/bindings/node/http",
        "src/jsc/bindings/sqlite", "src/jsc/bindings/v8", "src/jsc/modules",
        "src/js/builtins", "src/runtime/napi", "src/uws_sys", "src/jsc/bindings/libuv",
    ]
    flags = ["-I" + str(bun / directory) for directory in dirs]
    flags += ["-I" + str(codegen)] + ["-I" + str(path.resolve()) for path in includes]
    flags += [
        "-include", str(bun / "src/jsc/bindings/root.h"),
        "-D_HAS_EXCEPTIONS=0", "-DLIBUS_USE_OPENSSL=1", "-DJSC_OBJC_API_ENABLED=0",
        "-DNAPI_EXPERIMENTAL=1", "-DNODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT=1",
        "-DNOMINMAX", "-DUSE_BUN_MIMALLOC=0", "-fconstexpr-steps=6000000",
        "-Wno-error", "-w", "-ferror-limit=30",
    ]
    return flags


def ninja_escape(value):
    return str(value).replace("$", "$$").replace(" ", "$ ").replace(":", "$:")


def cpp(args):
    bun = args.bun.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    codegen = args.codegen.resolve()
    jsc = args.jsc.resolve()
    sources = [bun / line for line in (codegen / "cxx-sources.txt").read_text().splitlines() if line]
    sources += sorted(codegen.glob("*.cpp"))
    if args.sample:
        names = set(args.sample)
        sources = [path for path in sources if path.name in names]
    if not sources:
        raise SystemExit("No sources selected")
    compiler = Path(os.environ["WASI_SDK_PATH"]) / "bin/clang++"
    flags = jsc_flags(jsc) + bun_flags(bun, codegen, args.include)
    ninja = ["rule probe", "  command = $command", "  description = WASI $source"]
    objects = []
    for index, source in enumerate(sources):
        stem = f"{index:04d}-{source.stem}"
        obj = output / (stem + ".o")
        log = output / (stem + ".log")
        manifest = output / (stem + ".command.json")
        command = [str(compiler)] + flags + ["-c", str(source), "-o", str(obj)]
        manifest.write_text(json.dumps({
            "command": command, "cwd": str(jsc / "build/jsc"),
            "source": str(source), "log": str(log),
        }, indent=2) + "\n")
        edge = shell([sys.executable, __file__, "unit", "--manifest", manifest])
        ninja += [f"build {ninja_escape(obj)}: probe {ninja_escape(source)} | {ninja_escape(manifest)}",
                  f"  command = {edge.replace('$', '$$')}",
                  f"  source = {ninja_escape(source.name)}"]
        objects.append(ninja_escape(obj))
    ninja += ["default " + " ".join(objects)]
    (output / "build.ninja").write_text("\n".join(ninja) + "\n")
    status = subprocess.run(["ninja", "-C", str(output), "-k0", f"-j{args.jobs}"]).returncode
    summarize(output)
    return status


def category(message, path):
    if "file not found" in message:
        if any(word in message for word in ("sys/", "netdb.h", "netinet/", "pthread", "signal", "termios.h", "spawn.h", "mach/")):
            return "platform/POSIX"
        return "dependency/header setup"
    if any(word in message for word in ("sizeof", "static assertion", "BigInt functions", "uintptr", "JSValue64")):
        return "32-bit ABI/layout"
    if any(word in message for word in ("pthread", "Thread", "thread_local", "atomic")):
        return "threads/atomics"
    if any(word in message for word in ("sigaction", "SIG", "signal", "sigset")):
        return "signals"
    if any(word in message for word in ("StreamingCompiler", "JIT", "DOMJIT", "Assembler", "RegisterID", "Int52", "jsDoubleNumber")):
        return "disabled JIT/JS WebAssembly"
    if any(word in message for word in ("inspector", "Inspector", "SamplingProfiler", "samplingProfiler")):
        return "disabled inspector/profiler"
    if any(word in message for word in ("JSC::", "JSValue", "JSCell", "WTF::", "jsNumber")):
        return "JSC API/type mismatch"
    if any(word in message for word in ("libc", "socket", "fstat", "dlopen", "RTLD", "CLOCK_", "O_", "stat64", "S_IF", "AF_", "F_", "SO_", "MADV", "rlimit", "MAP_")):
        return "platform/POSIX"
    return "other/cascade"


def summarize(output):
    units = [json.loads(path.read_text()) for path in sorted(output.glob("[0-9]*.json"))
             if not path.name.endswith(".command.json")]
    diagnostics = []
    for unit in units:
        for match in DIAGNOSTIC.finditer(Path(unit["log"]).read_text()):
            path, line, column, message = match.groups()
            diagnostics.append({"source": unit["source"], "path": path, "line": int(line),
                                "column": int(column), "message": message,
                                "category": category(message, path)})
    unique = {(d["path"], d["line"], d["column"], d["message"]): d for d in diagnostics}
    summary = {
        "attempted": len(units), "passed": sum(unit["exit"] == 0 for unit in units),
        "failed": sum(unit["exit"] != 0 for unit in units),
        "diagnostics": len(diagnostics), "unique_diagnostics": len(unique),
        "categories": dict(Counter(d["category"] for d in diagnostics)),
        "unique_categories": dict(Counter(d["category"] for d in unique.values())),
        "passed_sources": [unit["source"] for unit in units if unit["exit"] == 0],
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (output / "diagnostics.json").write_text(json.dumps(diagnostics, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


def exports(args):
    nm = str(Path(os.environ["WASI_SDK_PATH"]) / "bin/llvm-nm")
    prefixes = ("_ZN3JSC", "_ZNK3JSC", "_ZN3WTF", "_ZNK3WTF")
    objects = sorted(args.output.glob("*.o"))
    archives = sorted((args.jsc / "build/jsc/lib").glob("*.a"))
    undefined = set()
    defined = set()
    for path in objects:
        result = subprocess.run([nm, "--undefined-only", "-j", str(path)], check=True,
                                capture_output=True, text=True)
        undefined.update(symbol for symbol in result.stdout.splitlines() if symbol.startswith(prefixes))
    for path in archives + objects:
        result = subprocess.run([nm, "--defined-only", "--extern-only", "-j", str(path)], check=True,
                                capture_output=True, text=True)
        defined.update(symbol for symbol in result.stdout.splitlines() if symbol.startswith(prefixes))
    report = {
        "objects": len(objects), "referenced_jsc_wtf_symbols": len(undefined),
        "missing": sorted(undefined - defined),
        "scope": "mangled JSC/WTF names in successful objects only; not a complete Bun link",
    }
    (args.output / "exports.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    unit = commands.add_parser("unit")
    unit.add_argument("--manifest", required=True)
    codegen = commands.add_parser("codegen")
    codegen.add_argument("--bun", type=Path, default=ROOT / "vendor/bun")
    codegen.add_argument("--output", type=Path, required=True)
    compile_parser = commands.add_parser("cpp")
    compile_parser.add_argument("--bun", type=Path, default=ROOT / "vendor/bun")
    compile_parser.add_argument("--codegen", type=Path, required=True)
    compile_parser.add_argument("--jsc", type=Path, default=Path("/work/tmp/bun-wasm-jsc"))
    compile_parser.add_argument("--output", type=Path, required=True)
    compile_parser.add_argument("--include", type=Path, action="append", default=[])
    compile_parser.add_argument("--sample", nargs="+")
    compile_parser.add_argument("--jobs", type=int, choices=range(1, 7), default=6)
    summary = commands.add_parser("summarize")
    summary.add_argument("--output", type=Path, required=True)
    symbol_parser = commands.add_parser("exports")
    symbol_parser.add_argument("--output", type=Path, required=True)
    symbol_parser.add_argument("--jsc", type=Path, default=Path("/work/tmp/bun-wasm-jsc"))
    args = parser.parse_args()
    if args.mode == "unit":
        return run_unit(args)
    if args.mode == "cpp":
        return cpp(args)
    if args.mode == "summarize":
        summarize(args.output)
        return 0
    if args.mode == "exports":
        exports(args)
        return 0
    return subprocess.run([
        "bun", "scripts/build.ts", "--mode=codegen",
        "--build-dir=" + str(args.output.resolve()), "-j6", "-k0",
    ], cwd=args.bun).returncode


if __name__ == "__main__":
    sys.exit(main())
