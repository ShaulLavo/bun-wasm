import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { requiredGuestCompanions, verifyGuestBuildReceipt, verifyGuestCompanions } from "../guest-build-receipt";
import type { AcceptanceEngine } from "./next-acceptance-model";

function assetBytes(directory: string, name: string): Uint8Array {
  const path = join(directory, name);
  return existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(path + ".gz"));
}

export async function verifyAcceptanceAssets(options: { root: string; engine: AcceptanceEngine; revision: string; receipt?: string; scratch: string }) {
  const manifest: unknown = JSON.parse(readFileSync(join(options.root, "engine-builds.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object");
  const core = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm", browser: "bun-browser.wasm" }[options.engine];
  const side = options.engine === "quickjs" ? ["quickjs.wasm"] : options.engine === "jsc" ? ["jsc-engine.wasm"] : [];
  const assets: Record<string, string> = {};
  for (const name of [core].concat(side)) {
    const bytes = assetBytes(options.root, name);
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(Reflect.get(manifest, name), hash, `${name} served bytes match manifest`);
    assets[name] = hash;
  }
  if (!options.receipt) return assets;
  const receipt: unknown = JSON.parse(readFileSync(options.receipt, "utf8"));
  verifyGuestBuildReceipt(assetBytes(options.root, core), receipt);
  assert.equal(receipt.sourceManifest.source.head, options.revision, "Source revision matches canonical receipt");
  for (const companion of requiredGuestCompanions(receipt)) {
    assert.ok(Object.hasOwn(assets, companion.name), `Receipt engine companion belongs to selected engine: ${companion.name}`);
    writeFileSync(join(options.scratch, companion.name), assetBytes(options.root, companion.name));
  }
  await verifyGuestCompanions(receipt, options.scratch);
  return assets;
}
