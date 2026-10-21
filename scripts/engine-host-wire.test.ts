import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function sourceSection(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section ${start}`);
  return source.slice(from, to);
}

function evaluate(source: string, globals: object): unknown {
  return runInNewContext(source, globals);
}

function method(value: unknown, key: string): (...args: unknown[]) => unknown {
  assert.ok(value && typeof value === "object");
  const member: unknown = Reflect.get(value, key);
  assert.ok(typeof member === "function", `Missing source method ${key}`);
  return (...args) => Reflect.apply(member, value, args);
}

const host = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
const capturedCodecs = sourceSection(host, "const NativeTextEncoder = ", "const NativeBlob = ");
const wireSource = sourceSection(host, "const utf8 = ", "// --- calling the wasm");
const errorSource = sourceSection(host, "const ERRORS = ", "// Thrown to unwind after process.exit");
const globals = { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView, Error, TypeError, RangeError, SyntaxError };
const wire = evaluate(`${capturedCodecs}\n${wireSource}\n${errorSource}\n({
  roundTrip(value, overwrite = false) {
    const writer = new Writer();
    writer.value(value);
    const result = new Reader(writer.buf, writer.view, 0).value();
    if (overwrite) writer.buf.fill(0);
    return result;
  },
  nativeError,
})`, globals);
const roundTrip = method(wire, "roundTrip");
const nativeError = method(wire, "nativeError");

// Rust/wasm is not executed here. The model returns UTF-8 text with its BOM intact.
function rustUtf8DecodeModel(bytes: Uint8Array, fatal: boolean): unknown {
  return roundTrip(new TextDecoder("utf-8", { ignoreBOM: true, fatal }).decode(bytes));
}

// Only complete, nonsurrogate UTF-16LE code units are modeled.
function rustUtf16leDecodeModel(bytes: Uint8Array): unknown {
  assert.equal(bytes.length % 2, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const units = Array.from({ length: bytes.length / 2 }, (_, index) => view.getUint16(index * 2, true));
  assert.ok(units.every(unit => unit < 0xd800 || unit > 0xdfff));
  return roundTrip(String.fromCharCode(...units));
}

const web = readFileSync(new URL("../crates/bunwasm-runtime/src/js/web.js", import.meta.url), "utf8");
const publicSource = sourceSection(web, "  function toUint8(data)", "  // --- base64");
const publicCodecs = evaluate(`${publicSource}\n({
  decode(input, options, label = "utf-8") { return new TextDecoder(label, options).decode(input); },
})`, { ...globals, internal: {}, native: { utf8Decode: rustUtf8DecodeModel, utf16leDecode: rustUtf16leDecodeModel } });
const publicDecode = method(publicCodecs, "decode");

for (const count of [1, 2]) {
  const prefix = "\ufeff".repeat(count);
  test(`wire STR preserves ${count} leading BOMs with and without following text`, () => {
    assert.equal(roundTrip(prefix), prefix);
    assert.equal(roundTrip(`${prefix}Aé😀\0Z`), `${prefix}Aé😀\0Z`);
  });

  test(`wire object keys preserve ${count} leading BOMs without colliding with plain keys`, () => {
    const key = `${prefix}key`;
    const value = `${prefix}value`;
    const result = roundTrip({ key: "plain", [key]: value });
    assert.ok(result && typeof result === "object");
    assert.deepEqual(Object.keys(result), ["key", key]);
    assert.equal(Reflect.get(result, "key"), "plain");
    assert.equal(Reflect.get(result, key), value);
  });

  for (const label of ["utf-16le", "utf-16"]) {
    const bytes = new Uint8Array(Array.from({ length: count }, () => [0xff, 0xfe]).flat().concat([0x41, 0x00]));
    test(`public ${label} default decoder removes only one of ${count} BOMs through the wire model`, () => {
      assert.equal(publicDecode(bytes, undefined, label), `${prefix}A`.slice(1));
      assert.equal(publicDecode(bytes, { ignoreBOM: false }, label), `${prefix}A`.slice(1));
    });

    test(`public ${label} ignoreBOM decoder preserves ${count} BOMs through the wire model`, () => {
      assert.equal(publicDecode(bytes, { ignoreBOM: true }, label), `${prefix}A`);
    });
  }

  test(`public utf-8 default decoder removes only one of ${count} BOMs through the wire model`, () => {
    const bytes = new TextEncoder().encode(`${prefix}A`);
    assert.equal(publicDecode(bytes), `${prefix}A`.slice(1));
  });

  test(`public utf-8 ignoreBOM decoder preserves ${count} BOMs through the wire model`, () => {
    const bytes = new TextEncoder().encode(`${prefix}A`);
    assert.equal(publicDecode(bytes, { ignoreBOM: true }), `${prefix}A`);
  });
}

test("wire decoder preserves non-BOM Unicode, NUL, empty and nested strings across calls", () => {
  for (const text of ["", "Aé😀\0Z", "A\ufeffZ"]) assert.equal(roundTrip(text), text);
  const nested = roundTrip(["\ufefffirst", ["\ufeff\ufeffsecond", "last"]]);
  assert.ok(Array.isArray(nested) && Array.isArray(nested[1]));
  assert.equal(nested[0], "\ufefffirst");
  assert.equal(nested[1][0], "\ufeff\ufeffsecond");
  assert.equal(nested[1][1], "last");
});

test("wire BYTES keeps its ordinary Uint8Array copy after input and wire overwrite", () => {
  const input = new Uint8Array([0xef, 0xbb, 0xbf, 0, 65]);
  const result = roundTrip(input, true);
  input.fill(0);
  assert.ok(result instanceof Uint8Array);
  assert.equal(Object.getPrototypeOf(result), Uint8Array.prototype);
  assert.deepEqual(Array.from(result), [0xef, 0xbb, 0xbf, 0, 65]);
});

test("wire native error reconstruction preserves BOM message, name, and properties", () => {
  const info = roundTrip({ kind: "TypeError", message: "\ufeffinvalid\0é", name: "\ufeffCodecError", props: { "\ufeffcode": "\ufeffbad", count: 2 } });
  const error = nativeError(info);
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, "\ufeffinvalid\0é");
  assert.equal(error.name, "\ufeffCodecError");
  assert.equal(Reflect.get(error, "\ufeffcode"), "\ufeffbad");
  assert.equal(Reflect.get(error, "count"), 2);
});

test("public decoder model retains exact byte-view bounds, Unicode and NUL", () => {
  const text = "Aé😀\0Z";
  const encoded = new TextEncoder().encode(text);
  const backing = new Uint8Array(encoded.length + 2).fill(0xff);
  backing.set(encoded, 1);
  const views = [backing.subarray(1, -1), new DataView(backing.buffer, 1, encoded.length)];
  for (const view of views) assert.equal(publicDecode(view), text);
  assert.equal(publicDecode(), "");
  assert.throws(() => publicDecode("A"), TypeError);
});

test("public decoder model retains replacement versus fatal UTF-8 errors", () => {
  for (const bytes of [[0xc3], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const input = new Uint8Array(bytes);
    assert.equal(publicDecode(input), new TextDecoder().decode(input));
    assert.throws(() => publicDecode(input, { fatal: true }), TypeError);
  }
});
