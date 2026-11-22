import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const js = join(root, "crates/bunwasm-runtime/src/js");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-string-decoder-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function emit(name: string): string {
  const destination = join(scratch, `${name}.js`);
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(js, `${name}.ts`), destination]);
  expect(result.exitCode).toBe(0);
  return readFileSync(destination, "utf8");
}

function loadStringDecoder(maxLength?: number) {
  const bufferSource = runInNewContext(emit("buffer_source"), { Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView, TypeError })();
  const internal = {
    stringDecoderMaxLength: maxLength,
    require(name: string) {
      if (name === "buffer_source") return bufferSource;
      if (name === "buffer") return { Buffer };
      throw new Error(`Unexpected module ${name}`);
    },
  };
  return runInNewContext(emit("string_decoder"), { Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView, TypeError, Error })(internal) as {
    StringDecoder: new (encoding?: string) => {
      write(input: unknown): string;
      end(input?: unknown): string;
      text(input: unknown, offset?: unknown): string;
    };
  };
}

function loadJscInternals(engine: string, stringIs8Bit?: (value: unknown) => boolean | undefined) {
  const internal = { native: { engine, stringIs8Bit } };
  return runInNewContext(emit("jsc_internals"), { Error, TypeError })(internal) as {
    isLatin1String(value: unknown): boolean;
    isUTF16String(value: unknown): boolean;
  };
}

test("StringDecoder write() and end() enforce ERR_STRING_TOO_LONG at and above the cap", () => {
  const { StringDecoder } = loadStringDecoder(10);
  const expected = { code: "ERR_STRING_TOO_LONG", message: "Cannot create a string longer than 0xa characters" };

  // UTF-8: 10 bytes passes, 11 bytes throws in both write() and end().
  expect(new StringDecoder("utf8").write(Buffer.alloc(10, 0x61))).toBe("aaaaaaaaaa");
  expect(() => new StringDecoder("utf8").write(Buffer.alloc(11, 0x61))).toThrow(expected);
  expect(new StringDecoder("utf8").end(Buffer.alloc(10, 0x61))).toBe("aaaaaaaaaa");
  expect(() => new StringDecoder("utf8").end(Buffer.alloc(11, 0x61))).toThrow(expected);

  // Pending character + remaining chunk crossing the cap throws.
  const pending = new StringDecoder("utf8");
  expect(pending.write(Buffer.from([0xe2]))).toBe("");
  expect(() => pending.write(Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.alloc(10, 0x61)]))).toThrow(expected);

  // Hex doubles byte length: 5 bytes -> 10 chars passes, 6 bytes -> 12 chars throws.
  expect(new StringDecoder("hex").write(Buffer.alloc(5, 0xab))).toBe("ababababab");
  expect(() => new StringDecoder("hex").write(Buffer.alloc(6, 0xab))).toThrow(expected);
  expect(() => new StringDecoder("hex").end(Buffer.alloc(6, 0xab))).toThrow(expected);

  // Base64 expands 3 bytes -> 4 chars: 6 bytes -> 8 chars passes, 9 bytes -> 12 chars throws.
  expect(new StringDecoder("base64").write(Buffer.alloc(6, 0x61)).length).toBe(8);
  expect(() => new StringDecoder("base64").write(Buffer.alloc(9, 0x61))).toThrow(expected);
  expect(() => new StringDecoder("base64").end(Buffer.alloc(9, 0x61))).toThrow(expected);

  // UTF-16LE halves byte length: 20 bytes -> 10 chars passes, 22 bytes -> 11 chars throws.
  expect(new StringDecoder("utf16le").write(Buffer.alloc(20, 0x61)).length).toBe(10);
  expect(() => new StringDecoder("utf16le").write(Buffer.alloc(22, 0x61))).toThrow(expected);
  expect(() => new StringDecoder("utf16le").end(Buffer.alloc(22, 0x61))).toThrow(expected);

  // Flush-only end() with buffered bytes over cap also throws.
  const zeroCap = loadStringDecoder(0).StringDecoder;
  const flushed = new zeroCap("utf8");
  expect(flushed.write(Buffer.from([0xe2]))).toBe("");
  expect(() => flushed.end()).toThrow({ code: "ERR_STRING_TOO_LONG", message: "Cannot create a string longer than 0x0 characters" });
});

test("StringDecoder.text() preserves pending bytes and reads live intrinsic DataView bounds after offset coercion", () => {
  const { StringDecoder } = loadStringDecoder();
  const d = new StringDecoder("utf8");
  expect(d.write(Buffer.from([0xe2]))).toBe("");
  expect(d.text(Buffer.from([0x82, 0xac]), 0)).toBe("€");

  expect(d.write(Buffer.from([0xe2]))).toBe("");
  expect(d.text(Buffer.from([0x82, 0xac]), -1)).toBe("");
  expect(d.write(Buffer.from([0x82, 0xac]))).toBe("€");

  const ab = new ArrayBuffer(4, { maxByteLength: 8 });
  new Uint8Array(ab).set([0x41, 0x42, 0x43, 0x44]);
  const dv = new DataView(ab);
  let coercions = 0;
  expect(d.text(dv, { valueOf() { coercions++; ab.resize(2); return 0; } })).toBe("AB");
  expect(coercions).toBe(1);
});

test("jscInternals delegates physical string width on engines that expose it and throws unsupported elsewhere", () => {
  const jsc = loadJscInternals("jsc", (value) => {
    if (typeof value !== "string") throw new TypeError("Expected a string");
    return value === "8bit";
  });
  expect(jsc.isLatin1String("8bit")).toBe(true);
  expect(jsc.isUTF16String("8bit")).toBe(false);
  expect(jsc.isLatin1String("16bit-ascii")).toBe(false);
  expect(jsc.isUTF16String("16bit-ascii")).toBe(true);
  expect(() => jsc.isLatin1String(123)).toThrow("Expected a string");
  expect(() => jsc.isUTF16String(null)).toThrow("Expected a string");

  for (const engine of ["quickjs", "host"]) {
    const unsupported = loadJscInternals(engine);
    expect(() => unsupported.isLatin1String("abc")).toThrow(expect.objectContaining({ code: "ERR_UNSUPPORTED" }));
    expect(() => unsupported.isUTF16String("abc")).toThrow(expect.objectContaining({ code: "ERR_UNSUPPORTED" }));
  }
});
