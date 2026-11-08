import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchive, checkObject, checkRelocations } from "./check-build.ts";
import { importDelta } from "../scripts/side-import-delta.ts";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [out, report] = process.argv.slice(2);
assert(out && report);
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const side = join(out, "spidermonkey-engine.wasm");
const bytes = readFileSync(side);
assert(bytes.length <= 14_000_000, "G2 side exceeded the unchanged 14 MB stop line");
checkObject(bytes);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const allowed = new Set(["env", "GOT.mem", "GOT.func", "wasi_snapshot_preview1"]);
assert(imports.every(entry => allowed.has(entry.module)), "new side host namespace");
assert(imports.every(entry => !/wast|wasm_text_to_binary/.test(entry.name)), "shell-only Rust symbol reached the side");
const coreNames = readFileSync(join(root, "scripts/quickjs-core-exports.txt"), "utf8").trim().split(/\s+/);
assert.deepEqual(importDelta(module, new Set(coreNames)), [], "side imports must be admitted by the existing core contract");
const library = join(out, "libspidermonkey_g2.a");
const archive = checkArchive(readFileSync(library));
const relocs = execFileSync("llvm-readobj", ["--relocs", library], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
const relocationCounts = checkRelocations(relocs);
const linkedLog = readFileSync(join(report, "linked.log"), "utf8");
assert(linkedLog.includes("test result: ok. 1 passed; 0 failed"));
for (const tier of ["interp", "pbl"]) {
  const text: string = readFileSync(join(report, `${tier}.log`), "utf8");
  for (const marker of ["ok init tier=" + tier, "ok rooted value across GC", "ok catchable stack overflow RangeError",
    "ok uncatchable interrupt loop; catch=0 finally=0", "ok uncatchable interrupt inside catch; catch=0 finally=0",
    "ok uncatchable interrupt inside finally; catch=0 finally=0"]) assert(text.includes(marker), `${tier}: ${marker}`);
}
const sourceDirs = [join(root, "spidermonkey"), join(root, "crates/bunwasm-spidermonkey")];
const sources = sourceDirs.flatMap(dir => readdirSync(dir, { recursive: true, encoding: "utf8" })
  .map(path => join(dir, path)).filter(path => statSync(path).isFile()));
sources.push(join(root, "crates/bunwasm-host/src/main.rs"), join(root, "crates/bunwasm-host/src/linked.rs"),
  join(root, "scripts/src/engine-explicit-init.ts"), join(root, "scripts/src/engine-init.c"),
  join(root, "scripts/quickjs-core-exports.txt"), join(root, "tests/linker/spidermonkey/core.c"), join(root, "Cargo.lock"));
sources.sort();
writeFileSync(join(report, "side-imports.json"), JSON.stringify(imports, null, 2) + "\n");
writeFileSync(join(report, "g2-artifacts.json"), JSON.stringify({ gate: "G2", scope: "VM-only probe; not an Engine or producer generation",
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceFiles: sources.map(path => ({ path: relative(root, path), sha256: hash(path) })),
  sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
  evidence: ["interp.log", "pbl.log", "oom.log", "linked.log"].map(path => ({ path, sha256: hash(join(report, path)) })),
  nativeReceiptSha256: hash(join(out, "native.json")),
  artifacts: [side, join(out, "core.wasm"), library, join(out, "smoke.wasm")]
    .map(path => ({ path, bytes: statSync(path).size, sha256: hash(path) })),
  importDelta: [], shellRustImports: [], exceptionTags: 0, ...archive, relocationCounts,
  coreExportsSha256: hash(join(root, "scripts/quickjs-core-exports.txt")),
  coreCommandSha256: hash(join(out, "core.wasm.command.json")),
}, null, 2) + "\n");
