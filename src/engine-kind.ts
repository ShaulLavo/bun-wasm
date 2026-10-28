export type PairedEngine = "quickjs" | "jsc";
export type ProgramKind = "single" | PairedEngine;
export type ProgramFiles<T> =
  | { readonly kind: "single"; readonly core: T }
  | { readonly kind: "quickjs"; readonly core: T; readonly side: T }
  | { readonly kind: "jsc"; readonly core: T; readonly side: T };
export type PairedProgramFiles<T> = Exclude<ProgramFiles<T>, { kind: "single" }>;

export const ENGINE_SECTION = "bun-wasm-engine";
const profiles = {
  quickjs: { core: "bun.wasm", side: "quickjs.wasm", initialize: ["quickjs_initialize_memory", "quickjs_apply_data_relocs", "quickjs_call_ctors", "quickjs_register"], run: "quickjs_run" },
  jsc: { core: "bun-jsc.wasm", side: "jsc-engine.wasm", initialize: ["jsc_initialize_memory", "jsc_apply_data_relocs", "jsc_call_ctors", "jsc_register"], run: "jsc_run" },
} as const;

export function programProfile(kind: PairedEngine) { return profiles[kind]; }

export function programKind(module: WebAssembly.Module): ProgramKind {
  const sections = WebAssembly.Module.customSections(module, ENGINE_SECTION);
  const binding = WebAssembly.Module.exports(module).find(entry => entry.name === "bun_core_bind_engine");
  if (!sections.length && !binding) return "single";
  if (sections.length !== 1 || binding?.kind !== "function") throw new TypeError("Paired core requires exactly one bun-wasm-engine section and bind function");
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.length === 7 && bytes.every((byte, index) => byte === "quickjs".charCodeAt(index))) return "quickjs";
  if (bytes.length === 3 && bytes.every((byte, index) => byte === "jsc".charCodeAt(index))) return "jsc";
  throw new TypeError("Invalid bun-wasm-engine section: expected exactly quickjs or jsc");
}

export function verifyProgramSide(kind: PairedEngine, module: WebAssembly.Module): void {
  if (programKind(module) !== "single") throw new TypeError("Engine companion cannot be a paired core");
  const names = new Set(WebAssembly.Module.exports(module).filter(entry => entry.kind === "function").map(entry => entry.name));
  const profile = programProfile(kind);
  const required: readonly string[] = profile.initialize;
  if (required.concat([profile.run]).some(name => !names.has(name))) throw new TypeError(`Invalid ${kind} companion initializer/RUN profile`);
  const other = programProfile(kind === "quickjs" ? "jsc" : "quickjs");
  const forbidden: readonly string[] = other.initialize;
  if (forbidden.concat([other.run]).some(name => names.has(name))) throw new TypeError("Contradictory engine companion profile");
}

export function mapProgramFiles<T, U>(files: ProgramFiles<T>, map: (file: T) => U): ProgramFiles<U> {
  if (files.kind === "single") return { kind: "single", core: map(files.core) };
  return { kind: files.kind, core: map(files.core), side: map(files.side) };
}

export function parseProgramFiles<T>(value: unknown, parse: (file: unknown) => T): ProgramFiles<T> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) || !("core" in value)) throw new TypeError("Invalid program files");
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "single" && keys === "core,kind") return { kind: "single", core: parse(value.core) };
  if ((value.kind === "quickjs" || value.kind === "jsc") && keys === "core,kind,side" && "side" in value) {
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
    case "browser": case "source-cache-browser": case "tools": return "single";
    default: throw new TypeError(`Unknown guest build: ${String(build)}`);
  }
}
