import { tagProgramCore, type PairedEngine } from "../../src/engine-kind.ts";

const unsigned = (value: number): number[] => {
  const bytes: number[] = [];
  do { const next = value >>> 7; bytes.push((value & 127) | (next ? 128 : 0)); value = next; } while (value);
  return bytes;
};
const name = (value: string) => unsigned(value.length).concat(Array.from(new TextEncoder().encode(value)));
const vector = (items: number[][]) => unsigned(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
const imported = (module: string, label: string, descriptor: number[]) => name(module).concat(name(label), descriptor);
const exported = (label: string, kind: number, index: number) => name(label).concat([kind], unsigned(index));
const body = (code: number[]) => unsigned(code.length + 2).concat([0], code, [0x0b]);
const binary = (parts: number[][]) => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(parts.flat()));
const trace = (value: number) => [0x41, value, 0x10, 1];
const load = [0x23, 1, 0x28, 2, 0];
const store = (value: number) => [0x23, 1, 0x41, value, 0x36, 2, 0];
const requireWord = (value: number) => load.concat([0x41, value, 0x47, 0x04, 0x40, 0x00, 0x0b]);
const copyData = [0x23, 1, 0x41, 0, 0x41, 4, 0xfc, 8, 0, 0, 0xfc, 9, 0];
const dylink = section(0, name("dylink.0").concat([1, 4, 16, 2, 0, 0]));
const globals = [imported("env", "__stack_pointer", [3, 0x7f, 1]), imported("env", "__memory_base", [3, 0x7f, 0]), imported("env", "__table_base", [3, 0x7f, 0])];
const memory = (shared: boolean) => imported("env", "memory", [2].concat(shared ? [3, 1, 0x80, 0x80, 1] : [0, 1]));
const table = imported("env", "__indirect_function_table", [1, 0x70, 0, 1]);

/** Executable data/relocation fixture, not a qualified production guest. */
export function initializationPair(kind: PairedEngine, shared = false) {
  const imports = [imported("runtime_proc", "signal", [0, 0]), imported("env", "trace", [0, 1])];
  const exports = [exported("core_initialize_memory", 0, 2), exported("__wasm_apply_data_relocs", 0, 3),
    exported("__wasm_call_ctors", 0, 4), exported("bun_core_alloc", 0, 5), exported("_start", 0, 6),
    exported("read", 0, 7), exported("bun_core_bind_engine", 0, 8), exported("core_checkpoint", 0, 8), exported("trace", 0, 1)];
  const core = binary((shared ? [dylink] : []).concat([
    section(1, [4, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0, 0x60, 0, 1, 0x7f]),
    section(2, vector(shared ? imports.concat([memory(true), table], globals) : imports)),
    section(3, [7, 2, 2, 2, 0, 2, 3, 2]),
  ], shared ? [] : [
    section(4, [1, 0x70, 0, 1]), section(5, [1, 0, 1]),
    section(6, [2, 0x7f, 1, 0x41, 0x80, 0x80, 1, 0x0b, 0x7f, 0, 0x41, 16, 0x0b]),
  ], [
    section(7, vector(shared ? exports : exports.concat([exported("memory", 2, 0), exported("__indirect_function_table", 1, 0), exported("__stack_pointer", 3, 0)]))),
    section(12, [1]),
    section(10, vector([
      body(copyData.concat(trace(1))), body(requireWord(42).concat(store(43), trace(2))),
      body(requireWord(shared ? 43 : 42).concat(trace(3))), body(trace(4).concat([0x23, 1, 0x41, 32, 0x6a])),
      body(trace(9)), body(load), body([]),
    ])),
    section(11, vector([shared ? [1, 4, 42, 0, 0, 0] : [0, 0x41, 16, 0x0b, 4, 42, 0, 0, 0]])),
  ]));
  const initializers = [`${kind}_initialize_memory`, `${kind}_apply_data_relocs`, `${kind}_call_ctors`, `${kind}_register`, `${kind}_run`];
  const side = binary([
    dylink, section(1, [2, 0x60, 0, 0, 0x60, 1, 0x7f, 0]),
    section(2, vector([imported("env", "core_checkpoint", [0, 0]), imported("env", "trace", [0, 1]), memory(shared), table].concat(globals))),
    section(3, [5, 0, 0, 0, 0, 0]),
    section(7, vector(initializers.map((label, index) => exported(label, 0, index + 2)))),
    section(12, [1]),
    section(10, vector([
      body(copyData.concat(trace(5))), body(requireWord(22).concat(store(23), trace(6))),
      body(requireWord(23).concat(trace(7))), body(requireWord(23).concat(trace(8))), body(trace(9)),
    ])),
    section(11, vector([[1, 4, 22, 0, 0, 0]])),
  ]);
  return { kind, core: tagProgramCore(core, kind), side };
}
