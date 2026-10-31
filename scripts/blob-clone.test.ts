import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { checkPayload, expectedBytes, payload } from "../tests/fixtures/worker-blob-clone/payload.ts";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-blob-clone-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const root = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
function source(name: string) {
  const path = new URL(name, root).pathname;
  if (name.endsWith(".js")) return readFileSync(path, "utf8");
  const output = join(scratch, name + ".js");
  const result = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname, path, output]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return readFileSync(output, "utf8");
}

function runtime() {
  const context = createContext({
    ArrayBuffer, Uint8Array, DataView, Map, Set, Date, RegExp, Error, TypeError, RangeError,
    Number, String, Boolean, ReadableStream,
  });
  const internal = {
    native: {
      timeOrigin: () => 0, platformInfo: { version: "test", arch: "test" },
      utf8Encode: (text: string) => new TextEncoder().encode(text),
      utf8Decode: (bytes: Uint8Array, fatal: boolean) => new TextDecoder("utf-8", { ignoreBOM: true, fatal }).decode(bytes),
      base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
      base64Decode: (text: string) => new Uint8Array(Buffer.from(text, "base64")),
      transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
    },
    require(name: string): unknown {
      if (name === "streams") return { ReadableStream };
      if (name === "body_streams") return { remember: (stream: unknown) => stream };
      if (name === "web_brand") return () => {};
      if (name === "process") return { env: {} };
      assert.equal(name, "url_search_params");
      return runInContext(source("url_search_params.ts"), context)();
    },
  };
  const install = runInContext(source("web.js"), context)(internal);
  install((name: string, value: unknown) => { context[name] = value; }, () => {});
  const clone = runInContext(source("structured_clone.ts"), context)(internal).structuredClone;
  let restored = 0;
  const codec = runInContext(source("worker_codec.ts"), context)(internal).create({
    isPort: () => false,
    prepare() { throw new Error("Unexpected port transfer"); },
    restore() { restored++; throw new Error("Unexpected port restoration"); },
    activate() { throw new Error("Unexpected port activation"); },
  });
  return { Blob: context.Blob, clone, codec, restored: () => restored };
}

function blobBytes(blob: Blob): Uint8Array {
  const method: unknown = Reflect.get(blob, "_bytes");
  assert.ok(typeof method === "function");
  const bytes: unknown = Reflect.apply(method, blob, []);
  assert.ok(bytes instanceof Uint8Array);
  return bytes;
}

for (const mode of ["clone", "codec"]) {
  test(`${mode} preserves the public Blob, nested identities and independent bytes`, async () => {
    const host = runtime();
    const input = payload(host.Blob);
    const output = mode === "clone" ? host.clone(input) : host.codec.decode(JSON.parse(JSON.stringify(host.codec.encode(input))));
    await checkPayload(output, host.Blob);
    expect(output.blob).not.toBe(input.blob);
    expect(blobBytes(output.blob)).not.toBe(blobBytes(input.blob));
    expect(host.restored()).toBe(0);
  });
}

test("ordinary byte views remain a positive control for both serializers", () => {
  const host = runtime();
  const bytes = new Uint8Array(expectedBytes);
  for (const output of [host.clone(bytes), host.codec.decode(host.codec.encode(bytes))]) {
    expect(output).toBeInstanceOf(Uint8Array);
    expect(Array.from(output)).toEqual(expectedBytes);
    expect(output.buffer).not.toBe(bytes.buffer);
  }
});

test("codec preparation snapshots Blob bytes without early transfer commit", async () => {
  const host = runtime();
  const input = payload(host.Blob);
  const buffer = new ArrayBuffer(2);
  const plan = host.codec.prepare({ input, buffer }, [buffer]);
  expect(buffer.byteLength).toBe(2);
  blobBytes(input.blob).fill(99);
  plan.commit();
  expect(buffer.byteLength).toBe(0);
  const output = host.codec.decode(plan.graph);
  await checkPayload(output.input, host.Blob);
  expect(output.buffer.byteLength).toBe(2);
});

test("unsupported values still throw and failed Blob messages do not detach buffers", () => {
  const host = runtime();
  const blob = new host.Blob([new Uint8Array(expectedBytes)]);
  for (const invalid of [() => {}, Symbol("no"), Promise.resolve(), new WeakMap()]) {
    const buffer = new ArrayBuffer(2);
    assert.throws(() => host.clone({ blob, invalid }, { transfer: [buffer] }), { name: "DataCloneError" });
    assert.throws(() => host.codec.prepare({ blob, invalid }, [buffer]), { name: "DataCloneError" });
    expect(buffer.byteLength).toBe(2);
  }
  expect(() => host.codec.prepare(blob, [blob])).toThrow("Invalid transferable");
  expect(() => host.clone(blob, { transfer: [blob] })).toThrow();
  expect(host.restored()).toBe(0);
});

test("codec rejects malformed Blob nodes before restoring any port", () => {
  const host = runtime();
  for (const node of [["blob"], ["blob", "AA==", 1], ["blob", 1, ""], ["blob", "", "", "extra"]]) {
    const port = { id: "a", peer: "b", version: 1, sent: 0, received: 0, pending: [], closing: null, closed: false };
    const nodes = [["array", 2, [["0", 1], ["1", 2]]], ["port", port, 3], node, ["array", 0, []]];
    expect(() => host.codec.decode({ root: 0, nodes })).toThrow("Invalid worker message graph");
  }
  expect(host.restored()).toBe(0);
});
