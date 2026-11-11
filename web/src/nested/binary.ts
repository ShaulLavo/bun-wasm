// The few binary encodings the host writes itself: its two small import-only modules.

const encoder = new TextEncoder();
const HEADER = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];

export function unsigned(value: number): number[] {
  return value < 0x80 ? [value] : [(value & 0x7f) | 0x80].concat(unsigned(value >>> 7));
}

export function utf8Name(text: string): number[] {
  const bytes = encoder.encode(text);
  return unsigned(bytes.length).concat(Array.from(bytes));
}

export function section(id: number, content: readonly number[]): number[] {
  return [id].concat(unsigned(content.length), content);
}

export function compileSections(...sections: readonly number[][]): WebAssembly.Module {
  return new WebAssembly.Module(Uint8Array.from(HEADER.concat(...sections)));
}
