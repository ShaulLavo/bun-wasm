export type PairedEngine = "quickjs" | "jsc" | "hermes";
export type ProgramKind = "single" | PairedEngine;
export type ProgramFiles<T> =
  | { readonly kind: "single"; readonly core: T }
  | { readonly kind: "quickjs"; readonly core: T; readonly side: T }
  | { readonly kind: "jsc"; readonly core: T; readonly side: T }
  | { readonly kind: "hermes"; readonly core: T; readonly side: T };
export type PairedProgramFiles<T> = Exclude<ProgramFiles<T>, { kind: "single" }>;

export const ENGINE_SECTION = "bun-wasm-engine";
const profiles = {
  quickjs: { core: "bun.wasm", side: "quickjs.wasm", initialize: ["quickjs_initialize_memory", "quickjs_apply_data_relocs", "quickjs_call_ctors", "quickjs_register"], run: "quickjs_run" },
  jsc: { core: "bun-jsc.wasm", side: "jsc-engine.wasm", initialize: ["jsc_initialize_memory", "jsc_apply_data_relocs", "jsc_call_ctors", "jsc_register"], run: "jsc_run" },
  hermes: { core: "bun-hermes.wasm", side: "hermes-engine.wasm", initialize: ["hermes_initialize_memory", "hermes_apply_data_relocs", "hermes_call_ctors", "hermes_register"], run: "hermes_run" },
} as const;
const pairedEngines: readonly PairedEngine[] = ["quickjs", "jsc", "hermes"];

export function isPairedEngine(value: unknown): value is PairedEngine {
  return pairedEngines.some(engine => engine === value);
}

export function programProfile(kind: PairedEngine) { return profiles[kind]; }

/** Explicit initialization of a shared-group (PIE) core, before its side links. */
export const SHARED_GROUP_CORE_INITIALIZE = ["core_initialize_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"] as const;

/** A shared-group pair is a relocatable core and a side that imports a shared memory. Mixed halves are refused. */
export function sharedGroupPair(core: WebAssembly.Module, side: Uint8Array): boolean {
  const group = WebAssembly.Module.customSections(core, "dylink.0").length === 1;
  if (group !== (importedMemory(side)?.shared ?? false)) throw new TypeError("Core and engine side were built for different program profiles");
  return group;
}

interface Cursor { readonly bytes: Uint8Array; at: number }

function readUnsigned(cursor: Cursor): number {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = cursor.bytes[cursor.at++];
    if (byte === undefined) throw new TypeError("Truncated Wasm module");
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return value;
  }
  throw new TypeError("Invalid Wasm integer");
}

function readName(cursor: Cursor): string {
  const length = readUnsigned(cursor);
  cursor.at += length;
  return new TextDecoder().decode(cursor.bytes.subarray(cursor.at - length, cursor.at));
}

function readLimits(cursor: Cursor): { shared: boolean; maximum: number | undefined } {
  const flags = readUnsigned(cursor);
  if (flags > 3) throw new TypeError("Unsupported memory or table limits");
  readUnsigned(cursor);
  return { shared: (flags & 2) !== 0, maximum: flags & 1 ? readUnsigned(cursor) : undefined };
}

/** Skip one non-memory import descriptor. */
function skipImport(cursor: Cursor, kind: number | undefined): void {
  if (kind === 0) readUnsigned(cursor);
  else if (kind === 1) {
    cursor.at++;
    readLimits(cursor);
  } else if (kind === 3) cursor.at += 2;
  else throw new TypeError(`Unsupported import kind ${kind}`);
}

/** The limits of a module's `env.memory` import, read from its bytes, or undefined without one. */
export function importedMemory(bytes: Uint8Array): { shared: boolean; maximum: number | undefined } | undefined {
  const module: Cursor = { bytes, at: 8 };
  while (module.at < bytes.length) {
    const id = bytes[module.at++];
    const size = readUnsigned(module);
    if (id === 2) return memoryImport({ bytes: bytes.subarray(module.at, module.at + size), at: 0 });
    module.at += size;
  }
  return undefined;
}

/** The declared maximum of a module's own or imported memory in bytes, or undefined without one. */
export function memoryMaximumBytes(bytes: Uint8Array): number | undefined {
  const module: Cursor = { bytes, at: 8 };
  while (module.at < bytes.length) {
    const id = bytes[module.at++];
    const size = readUnsigned(module);
    const section: Cursor = { bytes: bytes.subarray(module.at, module.at + size), at: 0 };
    module.at += size;
    const limits = id === 2 ? memoryImport(section) : id === 5 && readUnsigned(section) > 0 ? readLimits(section) : undefined;
    if (limits) return limits.maximum === undefined ? undefined : limits.maximum * 65536;
  }
  return undefined;
}

function memoryImport(imports: Cursor): { shared: boolean; maximum: number | undefined } | undefined {
  for (let count = readUnsigned(imports); count > 0; count--) {
    const name = `${readName(imports)}.${readName(imports)}`;
    const kind = imports.bytes[imports.at++];
    if (kind !== 2) skipImport(imports, kind);
    else if (name === "env.memory") return readLimits(imports);
    else readLimits(imports);
  }
  return undefined;
}

export function programKind(module: WebAssembly.Module): ProgramKind {
  const sections = WebAssembly.Module.customSections(module, ENGINE_SECTION);
  const binding = WebAssembly.Module.exports(module).find(entry => entry.name === "bun_core_bind_engine");
  if (!sections.length && !binding) return "single";
  if (sections.length !== 1 || binding?.kind !== "function") throw new TypeError("Paired core requires exactly one bun-wasm-engine section and bind function");
  const bytes = new Uint8Array(sections[0]!);
  const kind = pairedEngines.find(engine => bytes.length === engine.length && bytes.every((byte, index) => byte === engine.charCodeAt(index)));
  if (kind) return kind;
  throw new TypeError("Invalid bun-wasm-engine section: expected exactly quickjs, jsc or hermes");
}

export function verifyProgramSide(kind: PairedEngine, module: WebAssembly.Module): void {
  if (programKind(module) !== "single") throw new TypeError("Engine companion cannot be a paired core");
  const names = new Set(WebAssembly.Module.exports(module).filter(entry => entry.kind === "function").map(entry => entry.name));
  const profile = programProfile(kind);
  const required: readonly string[] = profile.initialize;
  if (required.concat([profile.run]).some(name => !names.has(name))) throw new TypeError(`Invalid ${kind} companion initializer/RUN profile`);
  for (const other of pairedEngines.filter(engine => engine !== kind).map(programProfile)) {
    const forbidden: readonly string[] = other.initialize;
    if (forbidden.concat([other.run]).some(name => names.has(name))) throw new TypeError("Contradictory engine companion profile");
  }
}

export function mapProgramFiles<T, U>(files: ProgramFiles<T>, map: (file: T) => U): ProgramFiles<U> {
  if (files.kind === "single") return { kind: "single", core: map(files.core) };
  return { kind: files.kind, core: map(files.core), side: map(files.side) };
}

export function parseProgramFiles<T>(value: unknown, parse: (file: unknown) => T): ProgramFiles<T> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) || !("core" in value)) throw new TypeError("Invalid program files");
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "single" && keys === "core,kind") return { kind: "single", core: parse(value.core) };
  if (isPairedEngine(value.kind) && keys === "core,kind,side" && "side" in value) {
    return { kind: value.kind, core: parse(value.core), side: parse(value.side) };
  }
  throw new TypeError("Invalid program kind or companion fields");
}

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value);
  return bytes;
}

export function appendCustomSection(bytes: Uint8Array, name: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(name);
  const payload = Uint8Array.from(unsigned(label.length).concat(Array.from(label), Array.from(content)));
  const section = Uint8Array.from([0].concat(unsigned(payload.length), Array.from(payload)));
  const result = new Uint8Array(bytes.length + section.length);
  result.set(bytes);
  result.set(section, bytes.length);
  return result;
}

/** Decorate only an untagged generic core, before recording its final identity. */
export function tagProgramCore(bytes: Uint8Array, kind: PairedEngine): Uint8Array<ArrayBuffer> {
  const snapshot = Uint8Array.from(bytes);
  const module = new WebAssembly.Module(snapshot);
  if (WebAssembly.Module.customSections(module, ENGINE_SECTION).length
    || !WebAssembly.Module.exports(module).some(entry => entry.name === "bun_core_bind_engine" && entry.kind === "function")) throw new TypeError("Expected an untagged generic core");
  return appendCustomSection(snapshot, ENGINE_SECTION, new TextEncoder().encode(kind));
}

export function programKindForBuild(build: unknown): ProgramKind {
  switch (build) {
    case "quickjs": case "quickjs-minimal": return "quickjs";
    case "jsc": return "jsc";
    case "hermes": return "hermes";
    case "browser": case "source-cache-browser": case "tools": return "single";
    default: throw new TypeError(`Unknown guest build: ${String(build)}`);
  }
}
