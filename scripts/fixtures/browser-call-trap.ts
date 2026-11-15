const text = (value: string) => Array.from(new TextEncoder().encode(value));
const name = (value: string) => [value.length].concat(text(value));
const rawString = (value: string) => [value.length, 0, 0, 0].concat(text(value));
const string = (value: string) => [5].concat(rawString(value));
function leb(value: number, signed = false): number[] {
  const bytes: number[] = [];
  let more = true;
  while (more) {
    const byte = value & 127;
    value = signed ? value >> 7 : value >>> 7;
    more = signed ? !(value === 0 && !(byte & 64) || value === -1 && Boolean(byte & 64)) : value !== 0;
    bytes.push(byte | (more ? 128 : 0));
  }
  return bytes;
}
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
const body = (instructions: number[]) => leb(instructions.length + 1).concat([0], instructions);

/** Real core memory grows by one page inside bunwasm_call, then executes unreachable. */
export function browserTrapSource(imported = false, maximum: number | null = 8): Uint8Array {
  const descriptor = [8, 3, 0, 0, 0].concat(
    rawString("entry"), string("/control.ts"), rawString("natives"), [7, 1, 0, 0, 0], string("hostUseModuleRecords"),
    rawString("constants"), [8, 0, 0, 0, 0],
  );
  const limits = maximum === null ? [0, 1] : [1, 1].concat(leb(maximum));
  const functions = [
    body([0x41].concat(leb(4096, true), [0x0b])), body([0x0b]),
    body([0x41, 1, 0x40, 0, 0x1a, 0, 0x0b]), body([0x41, 0, 0x0b]),
    body([0x41].concat(leb(descriptor.length, true), [0x0b])), body([0x41, 1, 0x0b]),
  ];
  const exports = ["bunwasm_alloc", "bunwasm_describe", "bunwasm_call", "bunwasm_result_ptr", "bunwasm_result_len", "bunwasm_ready"];
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [4, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 0, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f]),
    imported ? section(2, [1].concat(name("env"), name("memory"), [2], limits)) : [],
    section(3, [6, 0, 1, 2, 3, 3, 3]), imported ? [] : section(5, [1].concat(limits)),
    section(7, [7].concat(name("memory"), [2, 0], exports.flatMap((value, index) => name(value).concat([0, index])))),
    section(10, [6].concat(functions.flat())),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(leb(descriptor.length), descriptor)),
  ));
}
