import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { apiChecks } from "../tests/fixtures/buffer-api-contract/checks.ts";
import { checkResizableConcat } from "../tests/fixtures/buffer-concat-resizable/check.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: SourceBuffer, transcode } = loadBufferSource();
for (const check of apiChecks(SourceBuffer, transcode)) test(check.name, check.run);

test("concat sizes captured views after all getters shrink their backing", () => {
  checkResizableConcat(SourceBuffer);
});

test("transcode accepts a byte array from another realm and rejects tag spoofs", () => {
  const result = transcode(new Uint8Array([0xe4]), "latin1", "utf8");
  assert.equal(result.toString("hex"), "c3a4");
  for (const source of [new Uint8ClampedArray([65]), { [Symbol.toStringTag]: "Uint8Array", length: 1, 0: 65 }]) {
    assert.throws(() => transcode(source, "ascii", "utf8"), { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
  }
});

test("transcode checks the live source after encoding coercion and before name validation", () => {
  for (const mode of ["detach", "shrink", "out-of-bounds"]) {
    const backing = new ArrayBuffer(4, { maxByteLength: 8 });
    const source = SourceBuffer.from(backing, 2, 2);
    const events: string[] = [];
    const from = { toString() {
      events.push("from");
      if (mode === "detach") backing.transfer();
      else backing.resize(mode === "shrink" ? 0 : 2);
      return "bad";
    } };
    const to = { toString() { events.push("to"); return "bad"; } };
    const result = Reflect.apply(transcode, undefined, [source, from, to]);
    assert(ArrayBuffer.isView(result));
    assert.equal(result.byteLength, 0);
    assert.deepEqual(events, ["from", "to"]);
  }
});

test("transcode enforces output buffer and UTF-16 pivot size limits at and above the cap", () => {
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
    "globalThis.factory = " + readFileSync(new URL("../crates/bunwasm-runtime/src/js/buffer_transcode.ts", import.meta.url), "utf8"),
  );
  const createTranscode = runInNewContext(source, { TextDecoder, TypeError, RangeError })();
  const capped = createTranscode({
    normalizeEncoding(value: unknown) {
      const text = String(value).toLowerCase();
      if (text === "utf8" || text === "utf16le" || text === "latin1" || text === "ascii") return text;
      return undefined;
    },
    invalidArgType(name: string) { return new TypeError(name); },
    bytesToString(bytes: Uint8Array, encoding: string) { return Buffer.from(bytes).toString(encoding as BufferEncoding); },
    fromString(text: string, encoding: string) { return Buffer.from(text, encoding as BufferEncoding); },
    allocate(size: number) { return Buffer.alloc(size); },
    maxBufferLength: 16,
    maxUtf16Units: 8,
  });

  // Latin-1 / ASCII -> UTF-16LE: length * 2 <= maxBufferLength passes, > throws RangeError("Out of memory").
  assert.equal(capped(new Uint8Array(8).fill(0x61), "latin1", "utf16le").byteLength, 16);
  assert.throws(() => capped(new Uint8Array(9).fill(0x61), "latin1", "utf16le"), { name: "RangeError", message: "Out of memory" });
  assert.equal(capped(new Uint8Array(8).fill(0x61), "ascii", "utf16le").byteLength, 16);
  assert.throws(() => capped(new Uint8Array(9).fill(0x61), "ascii", "utf16le"), { name: "RangeError", message: "Out of memory" });

  // UTF-16LE pivot: floor(length / 2) + odd-tail < maxUtf16Units passes, >= throws RangeError("Out of memory").
  assert.equal(capped(new Uint8Array(14), "utf16le", "utf8").byteLength, 7);
  assert.throws(() => capped(new Uint8Array(16), "utf16le", "utf8"), { name: "RangeError", message: "Out of memory" });
  assert.equal(capped(new Uint8Array(14), "utf16le", "utf16le").byteLength, 14);
  assert.throws(() => capped(new Uint8Array(15), "utf16le", "utf16le"), { name: "RangeError", message: "Out of memory" });

  // Latin-1 / ASCII -> UTF-8 pivot: length < maxUtf16Units passes, >= throws RangeError("Out of memory").
  assert.equal(capped(new Uint8Array(7).fill(0x61), "latin1", "utf8").byteLength, 7);
  assert.throws(() => capped(new Uint8Array(8).fill(0x61), "latin1", "utf8"), { name: "RangeError", message: "Out of memory" });
  assert.throws(() => capped(new Uint8Array(8).fill(0x61), "ascii", "utf8"), { name: "RangeError", message: "Out of memory" });

  // UTF-8 -> UTF-16LE is not blocked by the pivot check.
  assert.equal(capped(new Uint8Array(8).fill(0x61), "utf8", "utf16le").byteLength, 16);
});
