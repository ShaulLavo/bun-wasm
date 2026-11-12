import { expect, test } from "bun:test";
import { slotGuest } from "./fixtures/mixed-slot-guest";
import { installHostSlots, installHostSlotsViaImport } from "../src/net/trampoline";

for (const transport of ["table", "imports"]) {
  test(`combined slot forwards four arguments through ${transport}`, () => {
    const instance = slotGuest();
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("No memory");
    const calls: number[][] = [];
    const impls = { poll_io: (...args: number[]) => { calls.push(args); return -21; } };
    const dispatch = transport === "imports" ? installHostSlotsViaImport(instance, impls) : undefined;
    if (!dispatch) installHostSlots(instance, impls);
    const index = new DataView(memory.buffer).getUint32(8 + 18 * 4, true);
    const table = instance.exports.__indirect_function_table;
    if (!(table instanceof WebAssembly.Table)) throw new Error("No table");
    const result = dispatch ? dispatch(18, [32, 2, 77, 128]) : table.get(index)(32, 2, 77, 128);
    expect(result).toBe(-21);
    expect(calls).toEqual([[32, 2, 77, 128]]);
    expect(new DataView(memory.buffer).getUint32(8, true)).toBe(0);
  });
}
