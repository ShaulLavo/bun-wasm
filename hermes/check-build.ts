import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermesConsumerReceipt } from "./consumer-receipt.ts";
import { execFileSync } from "node:child_process";

const root = process.argv[2];
assert(root, "usage: node hermes/check-build.ts HERMES_BUILD_DIR");
const library = join(root, "wasi/lib/libhermesvm_bunwasm.a");
const commands: unknown = JSON.parse(readFileSync(join(root, "wasi/compile_commands.json"), "utf8"));
assert(Array.isArray(commands), "compile commands must be an array");
let cppCount = 0;
for (const raw of commands) {
  const entry: unknown = raw;
  assert(entry && typeof entry === "object" && "file" in entry && "command" in entry);
  assert(typeof entry.file === "string" && typeof entry.command === "string");
  if (!entry.file.endsWith(".cpp")) continue;
  assert(/(?:^|\s)-fPIC(?:\s|$)/.test(entry.command), `missing PIC: ${entry.file}`);
  cppCount++;
}
assert(cppCount > 0, "no C++ compile commands");

function leb(bytes: Buffer, cursor: { offset: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    assert(cursor.offset < bytes.length && shift < 35, "invalid wasm LEB");
    const value = bytes.readUInt8(cursor.offset++);
    result += (value & 127) * 2 ** shift;
    if ((value & 128) === 0) return result;
    shift += 7;
  }
}

function skipLimits(bytes: Buffer, cursor: { offset: number }): void {
  const flags = leb(bytes, cursor);
  assert((flags & 4) === 0, "expected wasm32 memory limits");
  leb(bytes, cursor);
  if (flags & 1) leb(bytes, cursor);
}

function checkImports(bytes: Buffer, start: number): void {
  const cursor = { offset: start };
  const count = leb(bytes, cursor);
  for (let i = 0; i < count; i++) {
    const moduleLength = leb(bytes, cursor);
    cursor.offset += moduleLength;
    const nameLength = leb(bytes, cursor);
    cursor.offset += nameLength;
    const kind = bytes.readUInt8(cursor.offset++);
    assert(kind !== 4, "Wasm exception tag import found");
    if (kind === 0) leb(bytes, cursor);
    else if (kind === 1) { cursor.offset++; skipLimits(bytes, cursor); }
    else if (kind === 2) skipLimits(bytes, cursor);
    else if (kind === 3) cursor.offset += 2;
    else assert.fail(`unknown import kind ${kind}`);
  }
}

function checkSections(bytes: Buffer): void {
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const id = bytes.readUInt8(cursor.offset++);
    const length = leb(bytes, cursor);
    assert(id !== 13, "Wasm exception tag section found");
    if (id === 2) checkImports(bytes, cursor.offset);
    cursor.offset += length;
    assert(cursor.offset <= bytes.length, "truncated wasm section");
  }
}

const archive = readFileSync(library);
assert.equal(archive.subarray(0, 8).toString(), "!<arch>\n");
let offset = 8;
let objectCount = 0;
let memoryBaseCount = 0;
while (offset < archive.length) {
  const size = Number(archive.subarray(offset + 48, offset + 58).toString().trim());
  assert(Number.isSafeInteger(size) && size >= 0 && offset + 60 + size <= archive.length);
  const member = archive.subarray(offset + 60, offset + 60 + size);
  offset += 60 + size + (size % 2);
  if (!member.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) continue;
  objectCount++;
  checkSections(member);
  if (member.includes(Buffer.from("__memory_base"))) memoryBaseCount++;
}
assert(objectCount > 0, "archive contains no Wasm objects");
assert(memoryBaseCount > 0, "PIC archive must reference __memory_base");
const cache = readFileSync(join(root, "wasi/CMakeCache.txt"), "utf8");
for (const [key, value] of [
  ["CMAKE_POSITION_INDEPENDENT_CODE", "ON"],
  ["HERMESVM_HEAP_HV_MODE", "HEAP_HV_PREFER32"],
  ["HERMESVM_LOG_HEAP_SEGMENT_SIZE", "20"],
  ["HERMES_CHECK_NATIVE_STACK", "ON"],
  ["HERMESVM_EXCEPTION_ON_OOM", "OFF"],
]) assert(new RegExp(`^${key}:[^=]+=${value}$`, "m").test(cache), `missing configure setting: ${key}=${value}`);
const source = join(root, "hermes");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(revision, "c36356f416ee19bb0d54c2e7ecb3c5fb0538a065");
// Read the retained compiler depfiles only after the native build has completed.
writeFileSync(join(root, "wasi/shim-dependencies.txt"), execFileSync("ninja", ["-C", join(root, "wasi"), "-t", "deps"], { maxBuffer: 64 * 1024 * 1024 }));
const receipt = {
  ...hermesConsumerReceipt(join(import.meta.dirname, ".."), root),
  library,
  source,
  revision,
  sourceDiffSha256: hash(execFileSync("git", ["-C", source, "diff", "HEAD", "--binary"], { maxBuffer: 16 * 1024 * 1024 })),
  compileCommandsSha256: hash(readFileSync(join(root, "wasi/compile_commands.json"))),
  configSha256: hash(readFileSync(join(root, "wasi/CMakeCache.txt"))),
  compiler: execFileSync(join(process.env.WASI_SDK_PATH ?? "", "bin/clang++"), ["--version"], { encoding: "utf8" }).trim(),
  flags: ["-fPIC", "-fno-exceptions", "-fno-rtti", "HV32", "1MiB segments", "native stack checks", "core-owned allocation"],
  sha256: createHash("sha256").update(archive).digest("hex"),
  bytes: archive.length,
  cppCommandsWithPIC: cppCount,
  wasmObjects: objectCount,
  objectsReferencingMemoryBase: memoryBaseCount,
  exceptionTagSections: 0,
};
writeFileSync(join(root, "vm-library.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

const smoke = process.argv[3];
if (smoke) {
  const bytes = readFileSync(smoke);
  checkSections(bytes);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
  assert(imports.every((entry) => entry.module === "wasi_snapshot_preview1"), "VM smoke imports outside WASI");
  assert(imports.every((entry) => !/mmap|munmap|mprotect|__cxa_throw/.test(entry.name)), "forbidden VM import");
  process.stdout.write(`smoke.wasm: ${bytes.length} bytes, ${imports.length} WASI imports, no EH tags or mman imports\n`);
}
