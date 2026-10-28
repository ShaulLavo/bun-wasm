import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as root from "bun-wasm";
import * as assets from "bun-wasm/asset";

const [corePath, sidePath] = process.argv.slice(2);
if (!corePath || !sidePath) throw new Error("Expected QuickJS core and JSC side paths");
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
