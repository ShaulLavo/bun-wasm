/**
 * The SpiderMonkey side/core adapter is deliberately outside the normal guest
 * receipt and publication contracts. It consumes only a parent-admitted N1
 * packet and emits an experimental pair receipt; no normal producer label is
 * created by this module.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importedMemory, tagProgramCore } from "../src/engine-kind.ts";
import { verifyEngineInputs } from "../spidermonkey/prepare-engine-inputs.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const requiredSideExports: readonly string[] = ["spidermonkey_initialize_memory", "spidermonkey_apply_data_relocs", "spidermonkey_call_ctors", "spidermonkey_register", "spidermonkey_run"];
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const linkerProvided = new Set(["__memory_base", "__table_base", "memory", "__indirect_function_table"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function importDelta(side: WebAssembly.Module, coreExports: ReadonlySet<string>): string[] {
  const sideExports = new Set(WebAssembly.Module.exports(side).map(entry => entry.name));
  return WebAssembly.Module.imports(side).filter(entry => entry.module === "env" || entry.module === "GOT.mem" || entry.module === "GOT.func")
    .filter(entry => !(entry.module === "env" && linkerProvided.has(entry.name)))
    .filter(entry => !coreExports.has(entry.name) && (entry.module === "GOT.mem" || !sideExports.has(entry.name)))
    .map(entry => `${entry.module}.${entry.name}`).sort();
}

function run(command: readonly string[], cwd: string): string {
  return execFileSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface SideCoreInputs {
  readonly schema: 1;
  readonly scope: "spidermonkey-side-core";
  readonly source: { readonly head: string; readonly tree: string };
  readonly native: { readonly receiptSha256: string; readonly archiveSha256: string; readonly archiveBytes: number; readonly profileSha256: string };
  readonly profile: "split";
}

export interface ExperimentalReceipt {
  readonly schema: 1;
  readonly experimental: true;
  readonly scope: "spidermonkey-side-core";
  readonly source: SideCoreInputs["source"];
  readonly native: SideCoreInputs["native"];
  readonly profile: "split";
  readonly core: { readonly sha256: string; readonly bytes: number };
  readonly side: { readonly sha256: string; readonly bytes: number };
}

function parseInputs(value: unknown): SideCoreInputs {
  assert(record(value) && value.schema === 1 && value.scope === "spidermonkey-side-core" && value.profile === "split", "Invalid SpiderMonkey side/core inputs");
  assert(record(value.source) && /^[0-9a-f]{40}$/.test(String(value.source.head)) && /^[0-9a-f]{40}$/.test(String(value.source.tree)), "Invalid SpiderMonkey source identity");
  assert(record(value.native) && digest(value.native.receiptSha256) && digest(value.native.archiveSha256) && digest(value.native.profileSha256)
    && positiveInteger(value.native.archiveBytes), "Invalid SpiderMonkey native identity");
  return { schema: 1, scope: "spidermonkey-side-core", source: { head: String(value.source.head), tree: String(value.source.tree) },
    native: { receiptSha256: value.native.receiptSha256, archiveSha256: value.native.archiveSha256, archiveBytes: value.native.archiveBytes, profileSha256: value.native.profileSha256 }, profile: "split" };
}

export function captureInputs(repository: string, nativeDirectory: string): SideCoreInputs {
  verifyEngineInputs(nativeDirectory);
  const receipt = readFileSync(resolve(nativeDirectory, "native-inputs.json"));
  const native: Record<string, unknown> = JSON.parse(receipt.toString("utf8"));
  assert(record(native.archive) && record(native.profile) && digest(native.archive.sha256) && digest(native.profile.sha256)
    && positiveInteger(native.archive.bytes));
  assert.equal(run(["git", "status", "--porcelain", "--untracked-files=normal"], repository), "", "Side/core source must be clean");
  const head = run(["git", "rev-parse", "HEAD"], repository);
  const tree = run(["git", "rev-parse", "HEAD^{tree}"], repository);
  assert(/^[0-9a-f]{40}$/.test(head) && /^[0-9a-f]{40}$/.test(tree), "Invalid source identity");
  return { schema: 1, scope: "spidermonkey-side-core", source: { head, tree }, native: {
    receiptSha256: hash(receipt), archiveSha256: native.archive.sha256, archiveBytes: native.archive.bytes, profileSha256: native.profile.sha256,
  }, profile: "split" };
}

interface Cursor { readonly bytes: Uint8Array; offset: number }
interface Section { readonly id: number; readonly payload: Uint8Array; readonly raw: Uint8Array }
interface ExportEntry { readonly name: string; readonly kind: number; readonly index: number }

function readU32(cursor: Cursor): number {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    const byte = cursor.bytes[cursor.offset++];
    assert(byte !== undefined, "Truncated Wasm integer");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
  }
  throw new TypeError("Wasm integer overflow");
}

function u32(value: number): number[] {
  const result: number[] = [];
  do {
    const next = value >>> 7;
    result.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value !== 0);
  return result;
}

function name(cursor: Cursor): string {
  const length = readU32(cursor);
  const end = cursor.offset + length;
  assert(end <= cursor.bytes.length, "Truncated Wasm name");
  const result = new TextDecoder().decode(cursor.bytes.subarray(cursor.offset, end));
  cursor.offset = end;
  return result;
}

function sections(bytes: Uint8Array): Section[] {
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0], "Invalid Wasm header");
  const result: Section[] = [];
  const cursor: Cursor = { bytes, offset: 8 };
  while (cursor.offset < bytes.length) {
    const begin = cursor.offset;
    const id = bytes[cursor.offset++];
    assert(id !== undefined, "Truncated Wasm section id");
    const size = readU32(cursor);
    const end = cursor.offset + size;
    assert(end <= bytes.length, "Truncated Wasm section");
    result.push({ id, payload: bytes.subarray(cursor.offset, end), raw: bytes.subarray(begin, end) });
    cursor.offset = end;
  }
  return result;
}

function exportEntries(payload: Uint8Array): ExportEntry[] {
  const cursor: Cursor = { bytes: payload, offset: 0 };
  const entries: ExportEntry[] = [];
  for (let count = readU32(cursor); count > 0; count--) entries.push({ name: name(cursor), kind: cursor.bytes[cursor.offset++]!, index: readU32(cursor) });
  assert.equal(cursor.offset, payload.length);
  return entries;
}

function encodeExport(entry: ExportEntry): number[] {
  const bytes = new TextEncoder().encode(entry.name);
  return u32(bytes.length).concat(Array.from(bytes), [entry.kind], u32(entry.index));
}

function makeSection(id: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.from([id].concat(u32(payload.length), Array.from(payload)));
}

function rejectExceptionTags(bytes: Uint8Array): void {
  assert(!sections(bytes).some(section => section.id === 13), "SpiderMonkey side contains exception tags");
}

/** Convert a just-linked side module without routing SpiderMonkey through the generic initializer helper. */
export function convertSideInitializers(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const input = Uint8Array.from(bytes);
  const before = sections(input);
  const start = before.find(section => section.id === 8);
  const exportSection = before.find(section => section.id === 7);
  assert(start && exportSection, "SpiderMonkey side must have start and export sections");
  const startIndex = readU32({ bytes: start.payload, offset: 0 });
  const original = exportEntries(exportSection.payload);
  assert(original.some(entry => entry.name === "__wasm_apply_data_relocs" && entry.kind === 0));
  assert(original.some(entry => entry.name === "__wasm_call_ctors" && entry.kind === 0));
  assert(!original.some(entry => requiredSideExports.slice(0, 3).includes(entry.name)));
  const memories = WebAssembly.Module.imports(new WebAssembly.Module(input)).filter(entry => entry.kind === "memory");
  assert.deepEqual(memories, [{ module: "env", name: "memory", kind: "memory" }], "SpiderMonkey side must import core memory");
  assert.equal(importedMemory(input)?.shared, false, "SpiderMonkey side is split-only");
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(input));
  assert.deepEqual(imports.filter(entry => entry.kind === "table"), [{ module: "env", name: "__indirect_function_table", kind: "table" }]);
  assert(!original.some(entry => entry.kind === 2 || entry.name === "memory" || entry.name === "__stack_pointer"), "Side already exports memory or stack");
  const stackIndex = imports.filter(entry => entry.kind === "global").findIndex(entry => entry.kind === "global" && entry.module === "env" && entry.name === "__stack_pointer");
  assert(stackIndex >= 0, "SpiderMonkey side must import __stack_pointer");
  const renamed = original.map(entry => entry.name === "__wasm_apply_data_relocs" ? { ...entry, name: "spidermonkey_apply_data_relocs" }
    : entry.name === "__wasm_call_ctors" ? { ...entry, name: "spidermonkey_call_ctors" } : entry).concat([
      { name: "spidermonkey_initialize_memory", kind: 0, index: startIndex }, { name: "__stack_pointer", kind: 3, index: stackIndex }, { name: "memory", kind: 2, index: 0 },
    ]);
  const payload = Uint8Array.from(u32(renamed.length).concat(...renamed.map(encodeExport)));
  const changed = before.filter(section => section.id !== 8).map(section => section.id === 7 ? makeSection(7, payload) : section.raw);
  const result = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(...changed.map(section => Array.from(section))));
  assert(WebAssembly.validate(result), "Converted SpiderMonkey side is invalid Wasm");
  rejectExceptionTags(result);
  return result;
}

export function verifySide(bytes: Uint8Array, core: Uint8Array, expected: SideCoreInputs): void {
  const module = new WebAssembly.Module(Uint8Array.from(bytes));
  const coreModule = new WebAssembly.Module(Uint8Array.from(core));
  for (const name of requiredSideExports) assert(WebAssembly.Module.exports(module).some(entry => entry.name === name && entry.kind === "function"), `SpiderMonkey side is missing function ${name}`);
  assert(!sections(bytes).some(section => section.id === 8), "SpiderMonkey side must not have an implicit start");
  assert.equal(WebAssembly.Module.customSections(module, "dylink.0").length, 1, "SpiderMonkey side requires dylink.0");
  assert.equal(importedMemory(bytes)?.shared, false, "SpiderMonkey side is not split-only");
  assert.deepEqual(importDelta(module, new Set(WebAssembly.Module.exports(coreModule).map(entry => entry.name))), [], "SpiderMonkey side has unresolved core imports");
  rejectExceptionTags(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module).filter(entry => entry.kind === "memory"), [{ module: "env", name: "memory", kind: "memory" }]);
  assert.deepEqual(WebAssembly.Module.imports(module).filter(entry => entry.kind === "table"), [{ module: "env", name: "__indirect_function_table", kind: "table" }]);
  assert.equal(expected.profile, "split");
}

function verifyCore(bytes: Uint8Array): void {
  const module = new WebAssembly.Module(Uint8Array.from(bytes));
  assert.equal(WebAssembly.Module.customSections(module, "bun-wasm-engine").length, 0, "Experimental core must be untagged before pairing");
  assert(WebAssembly.Module.exports(module).some(entry => entry.name === "bun_core_bind_engine" && entry.kind === "function"), "Core lacks engine binding");
}

function verifyTaggedCore(bytes: Uint8Array): void {
  const module = new WebAssembly.Module(Uint8Array.from(bytes));
  const sections = WebAssembly.Module.customSections(module, "bun-wasm-engine");
  assert.equal(sections.length, 1, "Experimental pair core must have one engine tag");
  assert.equal(new TextDecoder().decode(sections[0]), "spidermonkey", "Experimental pair core has the wrong engine tag");
  assert(WebAssembly.Module.exports(module).some(entry => entry.name === "bun_core_bind_engine" && entry.kind === "function"), "Core lacks engine binding");
}

function tagCore(bytes: Uint8Array, output: string): void {
  verifyCore(bytes);
  writeFileSync(output, tagProgramCore(bytes, "spidermonkey"));
}

function parseReceipt(value: unknown): ExperimentalReceipt {
  assert(record(value) && value.schema === 1 && value.experimental === true && value.scope === "spidermonkey-side-core" && value.profile === "split", "Invalid experimental SpiderMonkey receipt");
  const inputs = parseInputs(value);
  assert(record(value.core) && record(value.side), "Incomplete experimental SpiderMonkey receipt");
  assert(digest(value.core.sha256) && digest(value.side.sha256) && positiveInteger(value.core.bytes) && positiveInteger(value.side.bytes));
  return { ...inputs, experimental: true, core: { sha256: value.core.sha256, bytes: value.core.bytes }, side: { sha256: value.side.sha256, bytes: value.side.bytes } };
}

export function writePairReceipt(corePath: string, sidePath: string, inputs: SideCoreInputs, output = `${corePath}.spidermonkey.json`): ExperimentalReceipt {
  const core = readFileSync(corePath);
  const side = readFileSync(sidePath);
  verifyTaggedCore(core);
  verifySide(side, core, inputs);
  const receipt: ExperimentalReceipt = { schema: 1, experimental: true, scope: "spidermonkey-side-core", source: inputs.source, native: inputs.native, profile: "split",
    core: { sha256: hash(core), bytes: core.byteLength }, side: { sha256: hash(side), bytes: side.byteLength } };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

export function verifyPairReceipt(corePath: string, sidePath: string, receiptPath: string, inputs: SideCoreInputs): ExperimentalReceipt {
  const receipt = parseReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
  assert.deepEqual(receipt.source, inputs.source);
  assert.deepEqual(receipt.native, inputs.native);
  const core = readFileSync(corePath);
  const side = readFileSync(sidePath);
  assert.equal(hash(core), receipt.core.sha256);
  assert.equal(core.byteLength, receipt.core.bytes);
  assert.equal(hash(side), receipt.side.sha256);
  assert.equal(side.byteLength, receipt.side.bytes);
  verifyTaggedCore(core);
  verifySide(side, core, inputs);
  return receipt;
}

if (import.meta.main) {
  const [command, first, second, third, fourth] = process.argv.slice(2);
  if (command === "inputs" && first && second) {
    console.log(JSON.stringify(captureInputs(resolve(first), resolve(second))));
  } else if (command === "verify-native" && first) {
    verifyEngineInputs(resolve(first));
  } else if (command === "tag-core" && first && second) {
    tagCore(readFileSync(first), second);
  } else if (command === "convert-side" && first && second) {
    writeFileSync(second, convertSideInitializers(readFileSync(first)));
  } else if (command === "finalize-side" && first && second && third && fourth) {
    const side = convertSideInitializers(readFileSync(first));
    writeFileSync(third, side);
    verifySide(side, readFileSync(second), parseInputs(JSON.parse(readFileSync(fourth, "utf8"))));
  } else if (command === "write-pair" && first && second && third) {
    writePairReceipt(first, second, parseInputs(JSON.parse(readFileSync(third, "utf8"))));
  } else if (command === "verify-pair" && first && second && third && fourth) {
    verifyPairReceipt(first, second, third, parseInputs(JSON.parse(readFileSync(fourth, "utf8"))));
  } else {
    throw new Error("Usage: inputs REPOSITORY NATIVE_DIR | verify-native NATIVE_DIR | tag-core INPUT OUTPUT | convert-side INPUT OUTPUT | finalize-side INPUT CORE OUTPUT INPUTS | write-pair CORE SIDE INPUTS | verify-pair CORE SIDE RECEIPT INPUTS");
  }
}
