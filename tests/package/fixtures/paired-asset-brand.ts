import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as root from "bun-wasm";
import * as assets from "bun-wasm/asset";

import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { instantiateLinkPlan, prepareLinkPlan } from "waffle/link";

const [corePath, sidePath, smCorePath, smSidePath] = process.argv.slice(2);
if (!corePath || !sidePath || !smCorePath || !smSidePath) throw new Error("Expected QuickJS core, JSC side, and SpiderMonkey pair paths");
const core = new Uint8Array(await readFile(corePath));
const side = new Uint8Array(await readFile(sidePath));
const describe = (url: string, bytes: Uint8Array) => ({ url, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const asset = { kind: "quickjs", core: describe("https://example.test/core", core), side: describe("https://example.test/side", side) } satisfies root.BunWasmAsset;
const fetch = async (url: string) => new Response(url === asset.core.url ? core : side);

assert.equal(typeof root.installBunAdapters, "function");
assert.equal(root.BunWasmAssetError, assets.BunWasmAssetError);
for (const api of [root, assets]) {
  await assert.rejects(api.loadBunWasm({ asset, fetch }), error => error instanceof root.BunWasmAssetError && /initializer\/RUN/.test(error.message));
  await assert.rejects(api.loadBunWasm({ asset: { ...asset, core: { ...asset.core, sha256: "invalid" } }, fetch }), root.BunWasmAssetError);
  const branded = new root.BunWasmAssetError("fetch rejected an asset");
  const failures = [branded, new TypeError("side fetch failed"), new DOMException("cancelled", "AbortError")];
  for (const failure of failures) {
    await assert.rejects(api.loadBunWasm({ asset, fetch: async url => {
      if (url === asset.core.url) return new Response(core);
      throw failure;
    } }), error => error === failure);
  }
  const bodyFailure = new TypeError("side body read failed");
  await assert.rejects(api.loadBunWasm({ asset, fetch: async url => url === asset.core.url ? new Response(core) : new Response(new ReadableStream({
    start(controller) { controller.error(bodyFailure); },
  })) }), error => error === bodyFailure);
}
console.log("paired asset errors ok");

const smCore = new Uint8Array(await readFile(smCorePath));
const smSide = new Uint8Array(await readFile(smSidePath));
const smAsset = { kind: "spidermonkey", core: describe("https://example.test/sm-core", smCore), side: describe("https://example.test/sm-side", smSide) } satisfies root.BunWasmAsset;
assert.equal(root.ENGINE_BIN.spidermonkey, "/opt/bun/spidermonkey/bin");
for (const load of [root.loadBunWasm, assets.loadBunWasm]) {
  const module = await load({ asset: smAsset, fetch: async url => new Response(url === smAsset.core.url ? smCore : smSide) });
  const source = assets.programLinkPlan(module);
  assert(source);
  assert.equal(source.libraries[0]?.id, "spidermonkey");
  const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {}, namespaces: { runtime_proc: { signal: () => 0 } } });
  const linked = instantiateLinkPlan(await prepareLinkPlan(source), { wasi, checkActive() {} });
  try {
    const value = linked.entry.exports.value;
    assert.equal(typeof value, "function");
    if (typeof value !== "function") throw new Error("Missing tiny fixture value export");
    assert.equal(value(), 0);
    linked.initialize();
    assert.equal(value(), 42);
  } finally { linked.dispose(); wasi.descriptors.dispose(); }
  await assert.rejects(load({ asset: smAsset, fetch: async url => new Response(url === smAsset.core.url ? smCore : Uint8Array.of(0)) }), root.BunWasmAssetError);
}
console.log("spidermonkey package initialized 42");
