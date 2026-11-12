const name = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);

/** Real tiny wasm guest with ABI v2/count19 and a table reserving index zero. */
export function slotGuest(): WebAssembly.Instance {
  const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 1, 0x7f]), section(3, [1, 0]),
    section(4, [1, 0x70, 0, 1]), section(5, [1, 0, 1]),
    section(7, [3].concat(name("memory"), [2, 0], name("bun_wasm_host_slots"), [0, 0], name("__indirect_function_table"), [1, 0])),
    section(10, [1, 4, 0, 0x41, 0, 0x0b]),
  )));
  const instance = new WebAssembly.Instance(module);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("No fixture memory");
  const header = new DataView(memory.buffer);
  header.setUint32(0, 2, true);
  header.setUint32(4, 19, true);
  return instance;
}
