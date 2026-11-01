import { expect, test } from "bun:test";
import { convertCoreInitializers, convertEngineInitializers } from "./engine-explicit-init.ts";
import { sharedGroupMaxPages } from "./program-profile.ts";

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return bytes;
}

function name(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return u32(bytes.length).concat(bytes);
}

function section(id: number, payload: number[]): number[] {
  return [id].concat(u32(payload.length), payload);
}

type Limits = readonly number[];
const UNSHARED: Limits = [0, 1];
// flags 3 (shared, has maximum), minimum 1, maximum: the guest memory maximum in pages.
const GROUP: Limits = [3, 1].concat(u32(sharedGroupMaxPages()));

function fixture(options: { memory?: boolean; limits?: Limits; table?: boolean; stack?: boolean; start?: boolean; relocationKind?: number; conflicting?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const imports: number[][] = [];
  if (options.memory !== false) imports.push(name("env").concat(name("memory"), [2], options.limits ?? UNSHARED));
  if (options.table !== false) imports.push(name("env").concat(name("__indirect_function_table"), [1, 0x70, 0, 1]));
  if (options.stack !== false) imports.push(name("env").concat(name("__stack_pointer"), [3, 0x7f, 1]));
  const exports = [name("__wasm_apply_data_relocs").concat([options.relocationKind ?? 0, 0]), name("__wasm_call_ctors").concat([0, 1])];
  if (options.conflicting) exports.push(name("jsc_call_ctors").concat([0, 1]));
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(0, name("dylink.0").concat([1, 4, 0, 0, 0, 0])),
    section(1, [1, 0x60, 0, 0]),
    section(2, u32(imports.length).concat(imports.flat())),
    section(3, [3, 0, 0, 0]),
    section(7, u32(exports.length).concat(exports.flat())),
  );
  const start = options.start === false ? [] : section(8, [2]);
  return Uint8Array.from(bytes.concat(start, section(10, [3, 2, 0, 0x0b, 2, 0, 0x0b, 2, 0, 0x0b])));
}

for (const kind of ["quickjs", "jsc"] as const) {
  test(`${kind} conversion retains imported identities and exact custom bytes without instantiation`, () => {
    const input = fixture();
    const snapshot = input.slice();
    const before = new WebAssembly.Module(input);
    const output = convertEngineInitializers(input, kind);
    expect(input).toEqual(snapshot);
    const after = new WebAssembly.Module(output);
    expect(WebAssembly.Module.imports(after)).toEqual(WebAssembly.Module.imports(before));
    expect(WebAssembly.Module.customSections(after, "dylink.0")).toEqual(WebAssembly.Module.customSections(before, "dylink.0"));
    expect(WebAssembly.Module.exports(after)).toEqual([
      { name: `${kind}_apply_data_relocs`, kind: "function" },
      { name: `${kind}_call_ctors`, kind: "function" },
      { name: `${kind}_initialize_memory`, kind: "function" },
      { name: "__stack_pointer", kind: "global" },
      { name: "memory", kind: "memory" },
    ]);
    expect(() => convertEngineInitializers(output, kind)).toThrow();
  });
}

test("converter rejects missing shared resources, implicit initialization, and conflicting profiles", () => {
  for (const options of [{ memory: false }, { table: false }, { stack: false }, { start: false }, { relocationKind: 3 }, { conflicting: true }]) {
    expect(() => convertEngineInitializers(fixture(options), "jsc")).toThrow();
  }
  const valid = fixture();
  expect(() => convertEngineInitializers(valid.subarray(0, valid.length - 1), "jsc")).toThrow();
  expect(() => convertEngineInitializers(Uint8Array.of(0, 97, 115), "jsc")).toThrow();
});

test("a shared-group side keeps its imported group memory and never exports it", () => {
  const output = convertEngineInitializers(fixture({ limits: GROUP }), "quickjs", "shared-group");
  const module = new WebAssembly.Module(output);
  expect(WebAssembly.Module.exports(module).filter(entry => entry.kind === "memory")).toEqual([]);
  expect(WebAssembly.Module.exports(module).map(entry => entry.name)).toContain("quickjs_initialize_memory");
  expect(() => convertEngineInitializers(fixture({ limits: GROUP }), "quickjs")).toThrow(/profile/);
  expect(() => convertEngineInitializers(fixture(), "quickjs", "shared-group")).toThrow(/profile/);
  for (const engine of ["jsc"] as const) {
    expect(() => convertEngineInitializers(fixture({ limits: GROUP }), engine, "shared-group")).toThrow(/not qualified/);
  }
});

function coreFixture(options: { limits?: Limits; dylink?: boolean; exportMemory?: boolean; start?: boolean; missing?: string } = {}): Uint8Array<ArrayBuffer> {
  const imports = [name("env").concat(name("memory"), [2], options.limits ?? GROUP)];
  const names = ["__wasm_apply_data_relocs", "__wasm_call_ctors", "_start"].filter(entry => entry !== options.missing);
  const exports = names.map((entry, index) => name(entry).concat([0, index]));
  if (options.exportMemory) exports.push(name("memory").concat([2, 0]));
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0].concat(
    options.dylink === false ? [] : section(0, name("dylink.0").concat([1, 4, 0, 0, 0, 0])),
    section(1, [1, 0x60, 0, 0]),
    section(2, u32(imports.length).concat(imports.flat())),
    section(3, [4, 0, 0, 0, 0]),
    section(7, u32(exports.length).concat(exports.flat())),
    options.start === false ? [] : section(8, [3]),
  );
  return Uint8Array.from(bytes.concat(section(10, [4, 2, 0, 0x0b, 2, 0, 0x0b, 2, 0, 0x0b, 2, 0, 0x0b])));
}

test("a shared-group core's start becomes core_initialize_memory and nothing else changes", () => {
  const input = coreFixture();
  const output = convertCoreInitializers(input);
  const module = new WebAssembly.Module(output);
  expect(WebAssembly.Module.exports(module)).toEqual([
    { name: "__wasm_apply_data_relocs", kind: "function" },
    { name: "__wasm_call_ctors", kind: "function" },
    { name: "_start", kind: "function" },
    { name: "core_initialize_memory", kind: "function" },
  ]);
  expect(WebAssembly.Module.customSections(module, "dylink.0")).toEqual(WebAssembly.Module.customSections(new WebAssembly.Module(input), "dylink.0"));
  expect(() => convertCoreInitializers(output)).toThrow();
});

test("core conversion refuses anything but a PIE group image at the guest memory maximum", () => {
  const fixtures = [
    coreFixture({ limits: UNSHARED }),
    coreFixture({ limits: [3, 1].concat(u32(65536)) }),
    // A core linked for another capacity stage.
    coreFixture({ limits: [3, 1].concat(u32(sharedGroupMaxPages() / 2)) }),
    coreFixture({ limits: [3, 1].concat(u32(sharedGroupMaxPages() * 2)) }),
    coreFixture({ dylink: false }),
    coreFixture({ exportMemory: true }),
    coreFixture({ start: false }),
    coreFixture({ missing: "__wasm_apply_data_relocs" }),
  ];
  for (const bytes of fixtures) expect(() => convertCoreInitializers(bytes)).toThrow();
});
