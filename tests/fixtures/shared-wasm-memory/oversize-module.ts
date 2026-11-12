function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(value ? byte | 0x80 : byte);
  } while (value);
  return bytes;
}
function name(value: string) {
  return leb(value.length).concat(Array.from(value, char => char.charCodeAt(0)));
}
function section(id: number, bytes: number[]) {
  return [id].concat(leb(bytes.length), bytes);
}

export function oversizedModule() {
  const count = 30_000;
  const exports = leb(count);
  for (let index = 0; index < count; index++) {
    const text = `export_with_a_plain_long_name_${String(index).padStart(6, '0')}`;
    for (const byte of name(text)) exports.push(byte);
    exports.push(0, 0);
  }
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 0]),
    section(2, [1].concat(name('env'), name('memory'), [2, 3, 1, 2])),
    section(3, [1, 0]),
    section(7, exports),
    section(10, [1, 2, 0, 0x0b]),
  ));
  return new WebAssembly.Module(bytes);
}
