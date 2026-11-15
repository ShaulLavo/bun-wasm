import { expect, test } from "bun:test";
import { runtimeTextDecoder, singleByteCases } from "./text-decoder-controls";
import { decoderInputKinds, decoderInputView } from "../tests/fixtures/text-decoder/cases";
import { nativeTextDecoderCodec } from "./fixtures/native-text-decoder";

const { Decoder, handles } = runtimeTextDecoder();

test.each(singleByteCases)("shared TextDecoder decodes %s through the native codec", (label, input, expected) => {
  const bytes = Uint8Array.from(input);
  expect(new TextDecoder(label).decode(bytes)).toBe(expected);
  const decoder = new Decoder(label);
  expect(decoder.encoding).toBe(label);
  expect(decoder.decode(bytes)).toBe(expected);
});

test("label resolution uses the codec and rejects replacement labels", () => {
  for (const label of [" UTF-8\t", "latin1", "ascii", "unicodefffe", "utf-16be", "shift_jis"]) {
    const decoder = new Decoder(label);
    expect(decoder.encoding).toBe(new TextDecoder(label).encoding);
    decoder.decode();
  }
  for (const label of ["replacement", "iso-2022-cn", "\u00a0utf-8", "toString"]) {
    expect(() => new Decoder(label)).toThrow(RangeError);
  }
});

function streamed(Constructor: typeof TextDecoder, encoding: string, bytes: Uint8Array, width: number, shared: boolean) {
  const decoder = new Constructor(encoding);
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += width) {
    const chunk = bytes.subarray(offset, offset + width);
    const buffer = shared ? new SharedArrayBuffer(chunk.length + 4) : new ArrayBuffer(chunk.length + 4);
    const view = new Uint8Array(buffer, 2, chunk.length);
    view.set(chunk);
    output += decoder.decode(view, { stream: true });
  }
  return output + decoder.decode();
}

test("UTF-8 and both UTF-16 byte orders preserve state across every small window", () => {
  const text = "\uFEFFA\uFEFF\0éĀက�𐀀􏿿";
  const le = Buffer.from(text, "utf16le");
  const cases: [string, Uint8Array][] = [["utf-8", new TextEncoder().encode(text)], ["utf-16le", le], ["utf-16be", Buffer.from(le).swap16()]];
  for (const [encoding, bytes] of cases) checkWindows(encoding, bytes, text.slice(1));
});

function checkWindows(encoding: string, bytes: Uint8Array, expected: string) {
  for (const shared of [false, true]) {
    for (let width = 1; width <= 5; width++) {
      expect(streamed(TextDecoder, encoding, bytes, width, shared)).toBe(expected);
      expect(streamed(Decoder, encoding, bytes, width, shared)).toBe(expected);
    }
  }
}

test("malformed UTF-8 is rejected immediately and truncated input flushes once", () => {
  for (const Constructor of [TextDecoder, Decoder]) {
    const decoder = new Constructor();
    expect(decoder.decode(Uint8Array.of(0xf0), { stream: true })).toBe("");
    expect(decoder.decode(Uint8Array.of(0x8f), { stream: true })).toBe("��");
    expect(decoder.decode()).toBe("");
    expect(decoder.decode(Uint8Array.of(0xc1), { stream: true })).toBe("�");
    expect(decoder.decode(Uint8Array.of(0xf0, 0x9f), { stream: true })).toBe("");
    expect(decoder.decode()).toBe("�");
    expect(decoder.decode()).toBe("");
  }
});

test("fatal UTF-8 and UTF-16 failures release the codec and leave BOM serialization unspent", () => {
  for (const Constructor of [TextDecoder, Decoder]) checkFatal(Constructor);
});

function checkFatal(Constructor: typeof TextDecoder) {
  const cases: [string, number[], number[]][] = [["utf-8", [0xff], [0xef, 0xbb, 0xbf, 0x42]], ["utf-16le", [0, 0xdc], [0xff, 0xfe, 0x42, 0]], ["utf-16be", [0xdc, 0], [0xfe, 0xff, 0, 0x42]]];
  for (const [encoding, invalid, next] of cases) {
    const decoder = new Constructor(encoding, { fatal: true });
    expect(() => decoder.decode(Uint8Array.from(invalid), { stream: true })).toThrow(TypeError);
    expect(decoder.decode(Uint8Array.from(next))).toBe("B");
    expect(() => decoder.decode(Uint8Array.of(0xc0))).toThrow(expect.objectContaining({ code: "ERR_ENCODING_INVALID_ENCODED_DATA" }));
    expect(decoder.decode()).toBe("");
  }
}

test("invalid dictionaries and throwing getters preserve a pending stream", () => {
  const decoder = new Decoder();
  decoder.decode(Uint8Array.of(0xf0, 0x9f), { stream: true });
  for (const options of [5, "x", true, 0n, Symbol()]) {
    expect(() => Reflect.construct(Decoder, ["utf-8", options])).toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => Reflect.apply(decoder.decode, decoder, [new Uint8Array(), options])).toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" }));
  }
  const sentinel = new Error("getter");
  expect(() => decoder.decode(undefined, { get stream(): boolean { throw sentinel; } })).toThrow(sentinel);
  expect(decoder.decode(Uint8Array.of(0x92, 0xa9))).toBe("💩");
  for (const options of [null, undefined, {}, () => {}, []]) {
    const instance = Reflect.construct(Decoder, ["utf-8", options]);
    expect(Reflect.apply(instance.decode, instance, [Uint8Array.of(65), options])).toBe("A");
  }
});

test("BOM handling resets for each completed stream and ignoreBOM preserves it", () => {
  for (const ignoreBOM of [false, true]) {
    const decoder = new Decoder("utf-16le", { ignoreBOM });
    for (let count = 0; count < 2; count++) {
      expect(decoder.decode(Uint8Array.of(0xff), { stream: true })).toBe("");
      expect(decoder.decode(Uint8Array.of(0xfe, 65, 0))).toBe(ignoreBOM ? "\uFEFFA" : "A");
    }
  }
});

test("options getters run before reading the input bytes", () => {
  const bytes = new Uint8Array(4).fill(65);
  expect(new Decoder().decode(bytes, { get stream() { bytes.fill(66); return false; } })).toBe("BBBB");
  expect(new Decoder().decode(bytes, { get stream() { bytes.buffer.transfer(); return false; } })).toBe("");
});

test.each(decoderInputKinds)("detached %s input decodes as empty before or during options conversion", kind => {
  for (const Constructor of [TextDecoder, Decoder]) {
    const before = new ArrayBuffer(4);
    const detached = decoderInputView(before, kind);
    before.transfer();
    expect(new Constructor().decode(detached)).toBe("");
    const during = new ArrayBuffer(4);
    const input = decoderInputView(during, kind);
    expect(new Constructor().decode(input, { get stream() { during.transfer(); return false; } })).toBe("");
  }
});

test.each(decoderInputKinds.filter(kind => kind !== "ArrayBuffer"))("%s made out of bounds by the stream getter decodes as empty", kind => {
  for (const Constructor of [TextDecoder, Decoder]) {
    const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
    new Uint8Array(buffer).fill(65);
    const input = decoderInputView(buffer, kind);
    expect(new Constructor().decode(input, { get stream() { buffer.resize(1); return false; } })).toBe("");
  }
});

test("non-streaming calls and native errors release their handles", () => {
  const before = handles.size;
  const decoder = new Decoder("utf-8", { fatal: true });
  expect(handles.size).toBe(before + 1);
  expect(() => decoder.decode(Uint8Array.of(0xff))).toThrow(TypeError);
  expect(handles.size).toBe(before);
  for (let index = 0; index < 10; index++) expect(decoder.decode(Uint8Array.of(65))).toBe("A");
  expect(handles.size).toBe(before);
});

test("completed UTF-8 decodes reuse the stateless native operation", () => {
  const { streams, handles } = nativeTextDecoderCodec();
  const calls = { decoder: 0, push: 0, release: 0 };
  const { Decoder } = runtimeTextDecoder({
    decoder(...args) { calls.decoder++; return streams.decoder(...args); },
    push(...args) { calls.push++; return streams.push(...args); },
    release(...args) { calls.release++; return streams.release(...args); },
  });
  const decoder = new Decoder("utf-8", { fatal: true });
  expect(decoder.decode(Uint8Array.of(65))).toBe("A");
  for (let index = 0; index < 32; index++) expect(decoder.decode(Uint8Array.of(0xef, 0xbb, 0xbf, 66))).toBe("B");
  expect(() => decoder.decode(Uint8Array.of(0xff))).toThrow(expect.objectContaining({ code: "ERR_ENCODING_INVALID_ENCODED_DATA" }));
  expect(decoder.decode(Uint8Array.of(67))).toBe("C");
  expect(calls).toEqual({ decoder: 1, push: 1, release: 1 });
  expect(handles.size).toBe(0);
  expect(decoder.decode(Uint8Array.of(0xf0, 0x9f), { stream: true })).toBe("");
  expect(decoder.decode(Uint8Array.of(0x92, 0xa9))).toBe("💩");
  expect(decoder.decode(Uint8Array.of(68))).toBe("D");
  expect(calls).toEqual({ decoder: 2, push: 3, release: 2 });
  expect(handles.size).toBe(0);
});

test("stateless UTF-8 decodes retain malformed input, BOM and view semantics", () => {
  const decoder = new Decoder("utf-8", { ignoreBOM: true });
  decoder.decode();
  const oracle = new TextDecoder("utf-8", { ignoreBOM: true });
  for (const bytes of [Uint8Array.of(0xef, 0xbb, 0xbf, 65), Uint8Array.of(0xf0, 0x9f), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xe0, 0x80, 0x80), Uint8Array.of(0xff, 0xc1, 65)]) {
    expect(decoder.decode(bytes)).toBe(oracle.decode(bytes));
  }
  const bytes = Uint8Array.of(88, 65, 66, 89);
  expect(decoder.decode(bytes.subarray(1, 3))).toBe("AB");
  expect(decoder.decode(new DataView(bytes.buffer, 1, 2))).toBe("AB");
  expect(decoder.decode(bytes, { get stream() { bytes.buffer.transfer(); return false; } })).toBe("");
});

test("ArrayBuffer intrinsic slots remain valid after its prototype changes", () => {
  for (const Constructor of [TextDecoder, Decoder]) {
    const buffer = Uint8Array.of(65, 66).buffer;
    Object.setPrototypeOf(buffer, SharedArrayBuffer.prototype);
    expect(new Constructor().decode(buffer)).toBe("AB");
  }
});

test("DataView intrinsic slots remain valid with a Uint8Array prototype", () => {
  for (const Constructor of [TextDecoder, Decoder]) {
    const buffer = Uint8Array.of(88, 65, 66, 89).buffer;
    const view = new DataView(buffer, 1, 2);
    Object.setPrototypeOf(view, Uint8Array.prototype);
    expect(new Constructor().decode(view)).toBe("AB");
  }
});
