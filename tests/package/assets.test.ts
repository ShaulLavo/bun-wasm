import { quickjsPair } from "./quickjs-plan-fixture";
import { expect, test } from "bun:test";
import { BunWasmAssetError, loadBunWasm, prepareProgram, prepareQuickjsProgram, programLinkPlan, type BunWasmAsset } from "../../src/assets.js";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const hash = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
const file = { url: "https://example.test/immutable/bun.wasm", bytes: wasm.length, sha256: hash };
const asset = { kind: "single", core: file } satisfies BunWasmAsset;
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
  await expect(loadBunWasm({ asset: { ...asset, core: { ...file, sha256: "bad" } }, fetch: respond(wasm) })).rejects.toBeInstanceOf(BunWasmAssetError);
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
  const mutableFile = {
    url: file.url,
    bytes: original.length,
    sha256: new Bun.CryptoHasher("sha256").update(original).digest("hex"),
  };
  const mutable = { kind: "single", core: mutableFile } satisfies BunWasmAsset;
  await expect(loadBunWasm({ asset: mutable, fetch: async () => {
    mutableFile.sha256 = new Bun.CryptoHasher("sha256").update(changed).digest("hex");
    mutableFile.bytes = changed.length;
    return new Response(changed);
  } })).rejects.toThrow("SHA-256 mismatch");
});

test("snapshots the declared byte count before invoking fetch", async () => {
  const mutable = { kind: "single", core: { ...file } } satisfies BunWasmAsset;
  await expect(loadBunWasm({ asset: mutable, fetch: async () => {
    mutable.core.bytes = wasm.length + 1;
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

test("checks the paired side before preparing a QuickJS program", async () => {
  const paired = { kind: "quickjs", core: file, side: { ...file, url: "https://example.test/immutable/quickjs.wasm", sha256: "0".repeat(64) } } satisfies BunWasmAsset;
  const requested: string[] = [];
  await expect(loadBunWasm({ asset: paired, fetch: async url => {
    requested.push(url);
    return new Response(wasm);
  } })).rejects.toThrow("SHA-256 mismatch");
  expect(requested).toEqual([file.url, paired.side.url]);
});

test("snapshots paired metadata before the core fetch callback", async () => {
  const paired = { kind: "quickjs", core: file, side: { ...file, url: "https://example.test/immutable/quickjs.wasm", sha256: "0".repeat(64) } } satisfies BunWasmAsset;
  await expect(loadBunWasm({ asset: paired, fetch: async () => {
    paired.side.sha256 = hash;
    return new Response(wasm);
  } })).rejects.toThrow("SHA-256 mismatch");
});

test("brands a verified but wrong paired side as an invalid asset", async () => {
  const { core } = quickjsPair();
  const { side } = quickjsPair("jsc");
  const describe = (url: string, bytes: Uint8Array) => ({ url, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  const paired = { kind: "quickjs", core: describe("https://example.test/core", core), side: describe("https://example.test/side", side) } satisfies BunWasmAsset;
  await expect(loadBunWasm({ asset: paired, fetch: async url => new Response(url === paired.core.url ? core : side) })).rejects.toBeInstanceOf(BunWasmAssetError);
});

test("distinct valid QuickJS sides retain distinct Waffle program associations", async () => {
  const { core, side } = quickjsPair();
  const sideB = Uint8Array.from(Array.from(side).concat([0, 2, 1, 120]));
  expect(WebAssembly.validate(sideB)).toBe(true);
  const first = await prepareQuickjsProgram(core, side);
  const second = await prepareQuickjsProgram(core, sideB);
  expect(first).not.toBe(second);
  expect(await prepareQuickjsProgram(core, side)).toBe(first);
  expect(programLinkPlan(first)?.libraries[0]?.source).toEqual(side);
  expect(programLinkPlan(second)?.libraries[0]?.source).toEqual(sideB);
  expect(WebAssembly.Module.customSections(first, "bun-wasm-pair")).toHaveLength(1);
  expect(WebAssembly.Module.exports(first)).toEqual(WebAssembly.Module.exports(new WebAssembly.Module(core)));
  const ordinary = new WebAssembly.Module(wasm);
  expect(programLinkPlan(ordinary)).toBeUndefined();
  expect(await loadBunWasm({ module: ordinary })).toBe(ordinary);
});

test("paired preparation snapshots both inputs before asynchronous hashing", async () => {
  const { core, side } = quickjsPair();
  const originalCore = core.slice(), originalSide = side.slice();
  const pending = prepareQuickjsProgram(core, side);
  core.fill(0); side.fill(0);
  const module = await pending;
  expect(programLinkPlan(module)?.core.source.slice(0, originalCore.length)).toEqual(originalCore);
  expect(programLinkPlan(module)?.libraries[0]?.source).toEqual(originalSide);
});

test("prepares the verified pair and rejects its naked core override", async () => {
  const { core, side } = quickjsPair();
  const describe = (url: string, bytes: Uint8Array) => ({ url, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  const paired = { kind: "quickjs", core: describe("https://example.test/bun.wasm", core), side: describe("https://example.test/quickjs.wasm", side) } satisfies BunWasmAsset;
  const module = await loadBunWasm({ asset: paired, fetch: async url => new Response(url === paired.core.url ? core : side) });
  const plan = programLinkPlan(module);
  expect(plan?.core.source.slice(0, core.length)).toEqual(core);
  expect(plan?.core.source.length).toBeGreaterThan(core.length);
  expect(plan?.libraries[0]?.source).toEqual(side);
  expect(await loadBunWasm({ module })).toBe(module);
  await expect(loadBunWasm({ module: new WebAssembly.Module(core) })).rejects.toThrow("matching prepared side module");
});

for (const kind of ["quickjs", "jsc"] as const) test(`${kind} preparation rejects wrong side and snapshots caller buffers`, async () => {
  const { core, side } = quickjsPair(kind);
  const other = quickjsPair(kind === "jsc" ? "quickjs" : "jsc");
  await expect(prepareProgram({ kind, core, side: other.side })).rejects.toThrow("initializer/RUN");
  await expect(prepareProgram({ kind: kind === "jsc" ? "quickjs" : "jsc", core, side })).rejects.toThrow("core declaration");
  const expectedCore = core.slice(), expectedSide = side.slice();
  const pending = prepareProgram({ kind, core, side });
  core.fill(0); side.fill(0);
  const module = await pending;
  expect(programLinkPlan(module)?.core.source.slice(0, expectedCore.length)).toEqual(expectedCore);
  expect(programLinkPlan(module)?.libraries[0]?.source).toEqual(expectedSide);
});

test("paired preparation never compiles synchronously, which browser main threads refuse for large modules", async () => {
  const { core, side } = quickjsPair("jsc");
  const Module = WebAssembly.Module;
  const refused = new Proxy(Module, { construct() { throw new RangeError("WebAssembly.Compile is disallowed on the main thread"); } });
  Reflect.set(WebAssembly, "Module", refused);
  try {
    expect(programLinkPlan(await prepareProgram({ kind: "jsc", core, side }))?.libraries[0]?.source).toEqual(side);
  } finally {
    Reflect.set(WebAssembly, "Module", Module);
  }
});
