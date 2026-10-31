import { appendCustomSection, tagProgramCore, type PairedEngine } from "../../src/engine-kind";
const unsigned = (value: number): number[] => {
  const bytes: number[] = [];
  do { const next = value >>> 7; bytes.push((value & 127) | (next ? 128 : 0)); value = next; } while (value);
  return bytes;
};
const name = (value: string) => unsigned(value.length).concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
const entry = (label: string, kind: number, index: number) => name(label).concat([kind], unsigned(index));
const body = (code: number[]) => unsigned(code.length + 2).concat([0], code, [0x0b]);
const module = (parts: number[][]) => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(...parts));

export function quickjsPair(kind: PairedEngine = "quickjs"): { core: Uint8Array<ArrayBuffer>; side: Uint8Array<ArrayBuffer> } {
  const exports = [entry("memory", 2, 0), entry("__indirect_function_table", 1, 0), entry("__stack_pointer", 3, 0),
    entry("_start", 0, 1), entry("bun_core_alloc", 0, 2), entry("__wasm_call_ctors", 0, 3),
    entry("bun_core_bind_engine", 0, 4), entry("core_checkpoint", 0, 5), entry("value", 0, 6), entry("ctors", 3, 1)];
  const core = module([
    section(1, [4, 0x60, 0, 0, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f]),
    section(2, [1].concat(name("runtime_proc"), name("signal"), [0, 1])),
    section(3, [6, 0, 1, 0, 2, 0, 3]), section(4, [1, 0x70, 0, 1]), section(5, [1, 0, 1]),
    section(6, [2, 0x7f, 1, 0x41, 0x80, 0x08, 0x0b, 0x7f, 1, 0x41, 0, 0x0b]),
    section(7, [exports.length].concat(...exports)),
    section(10, [6].concat(body([]), body([0x41, 0x80, 0x08]), body([0x23, 1, 0x41, 1, 0x6a, 0x24, 1]),
      body([0x20, 0]), body([]), body([0x41, 0, 0x28, 2, 0]))),
  ]);
  const imports = [name("env").concat(name("core_checkpoint"), [0, 0]), name("env").concat(name("memory"), [2, 0, 1]),
    name("env").concat(name("__indirect_function_table"), [1, 0x70, 0, 1]),
    name("env").concat(name("__stack_pointer"), [3, 0x7f, 1])];
  const initializers = [`${kind}_initialize_memory`, `${kind}_apply_data_relocs`, `${kind}_call_ctors`, `${kind}_register`, `${kind}_run`];
  const side = module([
    section(0, name("dylink.0").concat([1, 4, 4, 2, 0, 0])), section(1, [1, 0x60, 0, 0]),
    section(2, [imports.length].concat(...imports)), section(3, [5, 0, 0, 0, 0, 0]),
    section(7, [initializers.length].concat(...initializers.map((label, index) => entry(label, 0, index + 1)))),
    section(10, [5].concat(body([]), body([]), body([]), body([0x41, 0, 0x41, 42, 0x36, 2, 0]), body([]))),
  ]);
  return { core: tagProgramCore(core, kind), side };
}

/** Synthetic decoder/receipt inputs only; no executable worker or production proof. */
export function sharedQuickjsPair(): { core: Uint8Array<ArrayBuffer>; side: Uint8Array<ArrayBuffer> } {
  const memory = section(2, [1].concat(name("env"), name("memory"), [2, 3, 1, 0x80, 0x40]));
  const parts = [section(1, [1, 0x60, 0, 0]), memory, section(3, [1, 0])];
  const code = section(10, [1].concat(body([])));
  const exported = (names: string[]) => section(7, [names.length].concat(...names.map(label => entry(label, 0, 0))));
  const core = module(parts.concat([exported(["bun_core_bind_engine", "core_initialize_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"]), code]));
  const side = module(parts.concat([exported(["quickjs_initialize_memory", "quickjs_apply_data_relocs", "quickjs_call_ctors", "quickjs_register", "quickjs_run"]), code]));
  return { core: tagProgramCore(appendCustomSection(core, "dylink.0", new Uint8Array()), "quickjs"), side };
}
