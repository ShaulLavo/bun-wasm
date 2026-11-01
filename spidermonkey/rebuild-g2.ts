import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchive, checkRelocations } from "./check-build.ts";

const recipe = dirname(fileURLToPath(import.meta.url));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(record(value), `invalid record: ${path}`);
  return value;
}
export type CompileEntry = { directory: string; file: string; arguments: string[] };
export function parseCommands(value: unknown): CompileEntry[] {
  assert(Array.isArray(value));
  return value.map(entry => {
    assert(record(entry) && typeof entry.directory === "string" && typeof entry.file === "string");
    assert(Array.isArray(entry.arguments) && entry.arguments.every((arg: unknown) => typeof arg === "string"));
    return { directory: entry.directory, file: entry.file, arguments: entry.arguments };
  });
}
export function compileArguments(entry: CompileEntry, source: string, output: string): string[] {
  const args = entry.arguments.slice(1);
  const outputFlag = args.indexOf("-o");
  const sourceIndex = args.indexOf(entry.file);
  assert(outputFlag >= 0 && outputFlag + 1 < args.length && sourceIndex >= 0, "incomplete compiler recipe");
  args[outputFlag + 1] = output;
  args[sourceIndex] = source;
  return args.concat(["-DBUNWASM_EMBED=1"]);
}
type CompileCommand = { directory: string; command: string; arguments: string[]; output: string };
function commandFor(object: string, entries: readonly CompileEntry[], baseline: string, out: string): CompileCommand {
  assert(object.startsWith(join(baseline, "obj") + "/") && object.endsWith(".o"), "object outside baseline");
  const generated = object.replace(/\.o$/, ".cpp");
  const first = existsSync(generated) ? readFileSync(generated, "utf8").match(/^#include "([^"]+)"/m)?.[1] : undefined;
  const entry = entries.find(e => e.directory === dirname(object) && (first
    ? e.file === resolve(dirname(object), first) : basename(e.file).replace(/\.[^.]+$/, ".o") === basename(object)));
  assert(entry, `missing compiler recipe: ${object}`);
  const command = entry.arguments[0];
  assert(command);
  const output = join(out, relative(join(baseline, "obj"), object));
  mkdirSync(dirname(output), { recursive: true });
  return { directory: entry.directory, command, arguments: compileArguments(entry, first ? generated : entry.file, output), output };
}
function compile(command: CompileCommand, signal: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command.command, command.arguments, { cwd: command.directory, stdio: "inherit", signal });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? done() : reject(new Error(`compile ${command.output}: ${code}`)));
  });
}
type CompileState = { next: number; failure: unknown };
async function compileWorker(state: CompileState, commands: readonly CompileCommand[], signal: AbortSignal): Promise<void> {
  while (!state.failure && state.next < commands.length) {
    const command = commands[state.next++];
    assert(command);
    try { await compile(command, signal); } catch (error) { state.failure = error; }
  }
}
async function compileAll(commands: readonly CompileCommand[]): Promise<void> {
  const state: CompileState = { next: 0, failure: undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try { await Promise.all(Array.from({ length: 6 }, () => compileWorker(state, commands, controller.signal))); }
  finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  if (state.failure) throw state.failure;
}
function baselineReceipt(baseline: string): Record<string, unknown> & { library: string; sha256: string } {
  const receipt = readRecord(join(baseline, "receipt/vm-library.json"));
  assert(receipt.gate === "G1" && typeof receipt.library === "string" && typeof receipt.sha256 === "string");
  assert.equal(receipt.revision, "a5df22d986d4b626f771b4f8885241941601c35c");
  assert.equal(hash(receipt.library), receipt.sha256, "G1 baseline identity");
  assert.equal(hash(join(baseline, "obj/clangd/compile_commands.json")), receipt.compileCommandsSha256);
  assert.equal(hash(join(baseline, "obj/config.status")), receipt.configureStatusSha256);
  assert.equal(hash(join(baseline, "obj/js/src/js-confdefs.h")), receipt.confdefsSha256);
  return { ...receipt, library: receipt.library, sha256: receipt.sha256 };
}
async function main(): Promise<void> {
  const [baseline, out] = process.argv.slice(2);
  const sdk = process.env.WASI_SDK_PATH;
  assert(baseline && out && resolve(out) !== resolve(baseline) && sdk);
  const receipt = baselineReceipt(baseline);
  const nativeReceipt = join(out, "native.json");
  if (existsSync(nativeReceipt)) {
    const previous = readRecord(nativeReceipt);
    assert.equal(previous.baselineReceiptSha256, hash(join(baseline, "receipt/vm-library.json")));
    assert.equal(previous.patchSha256, hash(join(recipe, "spidermonkey-wasi.patch")));
    assert.equal(previous.compileCommandsSha256, hash(join(out, "compile-commands.json")));
    assert.equal(previous.librarySha256, hash(join(out, "libspidermonkey_g2.a")));
    process.stdout.write("G2 native archive verified unchanged\n");
    return;
  }
  const entries = parseCommands(JSON.parse(readFileSync(join(baseline, "obj/clangd/compile_commands.json"), "utf8")));
  const objects = readFileSync(join(baseline, "receipt/archive-objects.txt"), "utf8").trim().split("\n");
  mkdirSync(out, { recursive: true });
  const commands = objects.map(object => commandFor(object, entries, baseline, out));
  writeFileSync(join(out, "compile-commands.json"), JSON.stringify(commands, null, 2) + "\n");
  await compileAll(commands);
  const list = join(out, "archive-objects.txt");
  writeFileSync(list, commands.map(c => c.output).join("\n") + "\n");
  const library = join(out, "libspidermonkey_g2.a");
  execFileSync(join(sdk, "bin/llvm-ar"), ["rcs", library, "@" + list]);
  const archive = checkArchive(readFileSync(library));
  const relocs = execFileSync("llvm-readobj", ["--relocs", library], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const relocationCounts = checkRelocations(relocs);
  writeFileSync(nativeReceipt, JSON.stringify({ gate: "G2", scope: "experimental VM smoke only",
    baselineReceiptSha256: hash(join(baseline, "receipt/vm-library.json")), baselineLibrarySha256: receipt.sha256,
    patchSha256: hash(join(recipe, "spidermonkey-wasi.patch")), compileCommandsSha256: hash(join(out, "compile-commands.json")),
    librarySha256: hash(library), objects: commands.length, ...archive, relocationCounts,
    exceptionTags: 0, nonPicCodeRelocations: 0, absoluteLibcStateRelocations: 0,
  }, null, 2) + "\n");
  assert.equal(hash(receipt.library), receipt.sha256, "G1 archive remains immutable");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
