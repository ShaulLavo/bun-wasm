import { expect, test } from "bun:test";
import { BunWasmAssetError, loadBunWasm, type BunWasmAsset } from "../../src/assets.js";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const hash = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
const asset: BunWasmAsset = { url: "https://example.test/immutable/bun.wasm", bytes: wasm.length, sha256: hash };
const respond = (body: Uint8Array) => async () => new Response(new Uint8Array(body));

test("verifies an immutable guest before compiling", async () => {
  expect(await loadBunWasm({ asset, fetch: respond(wasm) })).toBeInstanceOf(WebAssembly.Module);
});

test("rejects changed guest bytes with the same byte count", async () => {
  const changed = wasm.slice();
  changed[4] = 2;
  await expect(loadBunWasm({ asset, fetch: respond(changed) })).rejects.toThrow("SHA-256 mismatch");
});

test("rejects wrong guest length, HTTP failures and invalid descriptors", async () => {
  await expect(loadBunWasm({ asset, fetch: respond(wasm.slice(1)) })).rejects.toThrow("byte count mismatch");
  await expect(loadBunWasm({ asset, fetch: async () => new Response(null, { status: 404 }) })).rejects.toThrow("HTTP 404");
  await expect(loadBunWasm({ asset: { ...asset, sha256: "bad" }, fetch: respond(wasm) })).rejects.toBeInstanceOf(BunWasmAssetError);
});

test("verifies decompressed bytes, not the gzip representation", async () => {
  expect(await loadBunWasm({ asset, fetch: respond(Bun.gzipSync(wasm)) })).toBeInstanceOf(WebAssembly.Module);
});

test("compiled module override makes no network request", async () => {
  const module = new WebAssembly.Module(wasm);
  expect(await loadBunWasm({ module, fetch: async () => { throw new Error("unexpected fetch"); } })).toBe(module);
});

test("snapshots descriptor integrity before invoking fetch", async () => {
  const original = new Uint8Array(Array.from(wasm).concat([0, 2, 1, 65]));
  const changed = original.slice();
  changed[changed.length - 1] = 66;
  expect(WebAssembly.validate(original)).toBe(true);
  expect(WebAssembly.validate(changed)).toBe(true);
  const mutable = {
    url: asset.url,
    bytes: original.length,
    sha256: new Bun.CryptoHasher("sha256").update(original).digest("hex"),
  };
  await expect(loadBunWasm({ asset: mutable, fetch: async () => {
    mutable.sha256 = new Bun.CryptoHasher("sha256").update(changed).digest("hex");
    mutable.bytes = changed.length;
    return new Response(changed);
  } })).rejects.toThrow("SHA-256 mismatch");
});

test("snapshots the declared byte count before invoking fetch", async () => {
  const mutable = { ...asset };
  await expect(loadBunWasm({ asset: mutable, fetch: async () => {
    mutable.bytes = wasm.length + 1;
    return new Response(wasm);
  } })).resolves.toBeInstanceOf(WebAssembly.Module);
});

test("rejects and cancels an oversized response without consuming its tail", async () => {
  let produced = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++;
      controller.enqueue(new Uint8Array(16));
    },
    cancel() { cancelled = true; },
  });
  await expect(loadBunWasm({ asset, fetch: async () => new Response(body) })).rejects.toThrow("exceeds the declared size");
  expect(cancelled).toBe(true);
  expect(produced).toBeLessThan(10);
  expect(body.locked).toBe(false);
});

test("rejects a response chunk larger than the compressed size allowance", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  });
  await expect(loadBunWasm({ asset, fetch: async () => new Response(body) })).rejects.toThrow("compressed size limit");
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("rejects decompressed expansion beyond the declared size", async () => {
  const inflated = new Uint8Array(512 * 1024);
  const compressed = Bun.gzipSync(inflated);
  expect(compressed.length).toBeLessThan(64 * 1024);
  await expect(loadBunWasm({ asset, fetch: respond(compressed) })).rejects.toThrow("exceeds the declared size");
});

test("recognizes a gzip header split across response chunks", async () => {
  const compressed = Bun.gzipSync(wasm);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed.slice(0, 1));
      controller.enqueue(compressed.slice(1));
      controller.close();
    },
  });
  expect(await loadBunWasm({ asset, fetch: async () => new Response(body) })).toBeInstanceOf(WebAssembly.Module);
});

test("URL override keeps integrity checks", async () => {
  let requested: string | undefined;
  await loadBunWasm({ asset, wasmUrl: "https://offline.test/bun.wasm", fetch: async input => { requested = input; return new Response(wasm); } });
  expect(requested).toBe("https://offline.test/bun.wasm");
});
