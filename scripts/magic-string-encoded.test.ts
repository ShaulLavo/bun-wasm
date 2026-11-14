import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type MagicString from "./fixtures/magic-string/magic-string.d.mts";

let scratch = "";
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
scratch = mkdtempSync(join(tmpdir(), "bun-wasm-magic-string-api-"));
const fixture = (name: string) => gunzipSync(readFileSync(new URL(`./fixtures/magic-string/${name}.gz`, import.meta.url))).toString();
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
writeFileSync(join(scratch, "codec.mjs"), fixture("codec.mjs"));

async function load(name: string, source: string) {
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, source.replace("'@jridgewell/sourcemap-codec'", "'./codec.mjs'"));
  const api: typeof import("./fixtures/magic-string/magic-string.d.mts") = await import(pathToFileURL(path).href);
  return api;
}

const original = fixture("original.mjs");
const candidate = process.env.BUNWASM_MAGIC_STRING_LOADED
  ? readFileSync(process.env.BUNWASM_MAGIC_STRING_LOADED, "utf8") : fixture("corrected.mjs");
const left = await load("original", original), right = await load("candidate", candidate);
const codec: { decode: (encoded: string) => number[][][] } = await import(pathToFileURL(join(scratch, "codec.mjs")).href);

test("retained fixtures and supplied loader output have the measured identities", () => {
  expect(sha256(original)).toBe("d637092a6c7dd947e1b27aef30e97d1a5f59dc39b69ef8f4f0e37e766e4df159");
  const measured = fixture("candidate.mjs");
  expect(sha256(measured)).toBe("0ff3919bd96940bb50b71f040f394432564c67da541c0b9f7d7998cf7eab7af0");
  expect(candidate).toBe(measured.replace("if (this.generateDecodedMap !== defaultGenerateDecodedMap) return new SourceMap(this.generateDecodedMap(options));", "const generateDecodedMap = this.generateDecodedMap;\n\t\tif (generateDecodedMap !== defaultGenerateDecodedMap) return new SourceMap(generateDecodedMap.call(this, options));"));
  expect(candidate).toBe(fixture("corrected.mjs"));
  expect(Object.getOwnPropertyNames(right.default.prototype)).toEqual(Object.getOwnPropertyNames(left.default.prototype));
});

function compare(before: MagicString, after: MagicString) {
  expect(after.toString()).toBe(before.toString());
  for (const hires of [false, true, "boundary"] as const) {
    const options = { hires, includeContent: true, file: "out/compiled.js", source: "src/input.js" };
    const expected = before.generateMap(options), actual = after.generateMap(options);
    expect(actual.toString()).toBe(expected.toString());
    expect(actual.toUrl()).toBe(expected.toUrl());
    const decoded = after.generateDecodedMap(options);
    expect(decoded).toEqual(before.generateDecodedMap(options));
    expect(codec.decode(actual.mappings)).toEqual(decoded.mappings);
    decoded.mappings[0]?.push([987]);
    decoded.names.push("changed");
    expect(after.generateMap(options).toString()).toBe(expected.toString());
  }
}

test("public editing and mapping APIs preserve bytes, decoded positions and ownership", () => {
  for (const source of ["", "\n", "\n\n", "abc\n", "a\r\nb\u2028\u2029😃é\n", "0123456789abcdef\n".repeat(8000)]) {
    compare(new left.default(source), new right.default(source));
    const ignored = { filename: "input.js", ignoreList: true };
    compare(new left.default(source, ignored), new right.default(source, ignored));
  }
  for (let seed = 0; seed < 120; seed++) compare(...editedPair(seed));
});

function editedPair(seed: number): [MagicString, MagicString] {
  const source = "0123456789abcdef\nABCDEFGHIJKLMNO\n";
  const pair: [MagicString, MagicString] = [new left.default(source), new right.default(source)];
  for (const value of pair) {
    value.prepend(seed % 2 ? "header\n\n" : "prefix");
    value.append(seed % 3 ? "\nfooter" : "tail\n");
    value.overwrite(1, 4, seed % 2 ? "x\ny\n" : "", { storeName: seed % 3 === 0 });
    value.appendLeft(8, "left\n");
    value.prependRight(8, "right");
    value.addSourcemapLocation(10);
    if (seed % 4 === 0) value.move(18, 22, 29);
    if (seed % 5 === 0) value.indent("  ");
  }
  return pair;
}

test("Bundle, SourceMap and custom decoded-map overrides retain their public behavior", () => {
  const before = new left.Bundle({ separator: "\n" }), after = new right.Bundle({ separator: "\n" });
  before.addSource({ filename: "one.js", content: new left.default("const a = 1;\n") });
  after.addSource({ filename: "one.js", content: new right.default("const a = 1;\n") });
  expect(after.generateMap({ hires: true }).toString()).toBe(before.generateMap({ hires: true }).toString());
  const decoded = new left.default("abc").generateDecodedMap();
  expect(new right.SourceMap(decoded).toString()).toBe(new left.SourceMap(decoded).toString());
  const instanceBefore = new left.default("abc"), instanceAfter = new right.default("abc");
  instanceBefore.generateDecodedMap = instanceAfter.generateDecodedMap = () => decoded;
  expect(instanceAfter.generateMap().toString()).toBe(instanceBefore.generateMap().toString());
  const savedBefore = left.default.prototype.generateDecodedMap, savedAfter = right.default.prototype.generateDecodedMap;
  try {
    left.default.prototype.generateDecodedMap = right.default.prototype.generateDecodedMap = () => decoded;
    expect(new right.default("xyz").generateMap().toString()).toBe(new left.default("xyz").generateMap().toString());
  } finally {
    left.default.prototype.generateDecodedMap = savedBefore;
    right.default.prototype.generateDecodedMap = savedAfter;
  }
});

test("ordinary invalid edits retain errors", () => {
  const operations = [(value: MagicString) => value.overwrite(10, 11, "bad"), (value: MagicString) => value.move(1, 4, 2), (value: MagicString) => value.overwrite(2, 2, "bad")];
  const result = (value: MagicString, operation: (value: MagicString) => unknown) => {
    try { operation(value); return null; }
    catch (error) { return error instanceof Error ? [error.name, error.message] : error; }
  };
  for (const operation of operations) expect(result(new right.default("abcdef"), operation)).toEqual(result(new left.default("abcdef"), operation));
});

test("decoded-map accessors are read once and called with the original receiver and options", () => {
  const options = { hires: true, file: "accessor.js" };
  const decoded = new left.default("abc").generateDecodedMap(options);
  expect(accessorMap(new right.default("abc"), options, decoded)).toBe(accessorMap(new left.default("abc"), options, decoded));
});

function accessorMap(value: MagicString, options: Parameters<MagicString["generateMap"]>[0], decoded: ReturnType<MagicString["generateDecodedMap"]>) {
  let reads = 0;
  const calls: { receiver: unknown; options: unknown }[] = [];
  Object.defineProperty(value, "generateDecodedMap", { get() {
    if (++reads !== 1) throw new Error("decoded-map getter read twice");
    return function (this: unknown, receivedOptions: unknown) {
      calls.push({ receiver: this, options: receivedOptions });
      return decoded;
    };
  } });
  const map = value.generateMap(options).toString();
  expect(reads).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.receiver).toBe(value);
  expect(calls[0]?.options).toBe(options);
  return map;
}
