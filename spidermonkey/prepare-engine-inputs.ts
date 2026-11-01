import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readRecord(path: string): Record<string, unknown> {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(record(data), `Invalid receipt ${path}`);
  return data;
}
function copyVerified(source: string, target: string, expected: unknown): void {
  assert.equal(digest(source), expected, `Input identity ${source}`);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  assert.equal(digest(target), expected, `Successor identity ${target}`);
}
export function verifyEngineInputs(target: string): void {
  const origin = readRecord(join(target, "native-inputs.json"));
  const native = readRecord(join(target, "g2-receipt.json"));
  const baseline = readRecord(join(target, "g1-receipt.json"));
  assert.equal(origin.schema, 1);
  assert.equal(origin.origin, "reused G2 native inputs, not a new Mozilla build");
  assert.equal(origin.revision, baseline.revision);
  assert.equal(digest(join(target, "g1-receipt.json")), native.baselineReceiptSha256);
  assert.equal(origin.baselineReceiptSha256, native.baselineReceiptSha256);
  assert.equal(digest(join(target, "g2-receipt.json")), origin.g2ReceiptSha256);
  assert.equal(digest(join(target, "libspidermonkey_g2.a")), native.librarySha256);
  assert.equal(origin.librarySha256, native.librarySha256);
  assert.equal(digest(join(target, "compile-commands.json")), native.compileCommandsSha256);
  assert.equal(digest(join(target, "js-confdefs.h")), baseline.confdefsSha256);
  assert.equal(digest(join(target, "mozconfig")), baseline.mozconfigSha256);
  assert.equal(native.patchSha256, digest(join(import.meta.dir, "spidermonkey-wasi.patch")));
  assert(record(baseline.headers));
  assert.equal(digest(join(target, "headers.json")), baseline.headers.sha256);
  const headers: unknown = JSON.parse(readFileSync(join(target, "headers.json"), "utf8"));
  assert(Array.isArray(headers) && headers.length === baseline.headers.count);
  for (const header of headers) {
    assert(record(header) && typeof header.path === "string" && !header.path.split("/").includes(".."));
    assert.equal(digest(join(target, "include", header.path)), header.sha256);
  }
}
export function prepareEngineInputs(baseline: string, g2: string, target: string): void {
  assert.notEqual(resolve(target), resolve(baseline));
  assert.notEqual(resolve(target), resolve(g2));
  const original = join(baseline, "receipt/vm-library.json");
  const native = readRecord(join(g2, "native.json"));
  const g1 = readRecord(original);
  assert.equal(native.gate, "G2");
  assert.equal(g1.gate, "G1");
  assert.equal(g1.revision, "a5df22d986d4b626f771b4f8885241941601c35c");
  assert.equal(digest(original), native.baselineReceiptSha256);
  assert.equal(digest(join(baseline, "libspidermonkey_bunwasm.a")), native.baselineLibrarySha256);
  assert.equal(digest(join(baseline, "obj/config.status")), g1.configureStatusSha256);
  assert.equal(digest(join(baseline, "obj/clangd/compile_commands.json")), g1.compileCommandsSha256);
  assert.equal(digest(join(baseline, "firefox/Cargo.toml")), g1.cargoManifestSha256);
  assert.equal(digest(join(import.meta.dir, "spidermonkey-wasi.patch")), native.patchSha256);
  const headerReceipt = join(baseline, "receipt/headers.json");
  assert(record(g1.headers));
  assert.equal(digest(headerReceipt), g1.headers.sha256);
  const headers: unknown = JSON.parse(readFileSync(headerReceipt, "utf8"));
  assert(Array.isArray(headers) && headers.length === g1.headers.count);
  for (const header of headers) {
    assert(record(header) && typeof header.path === "string" && !header.path.split("/").includes(".."));
    copyVerified(join(baseline, "obj/dist/include", header.path), join(target, "include", header.path), header.sha256);
  }
  copyVerified(join(baseline, "obj/js/src/js-confdefs.h"), join(target, "js-confdefs.h"), g1.confdefsSha256);
  copyVerified(join(baseline, "mozconfig"), join(target, "mozconfig"), g1.mozconfigSha256);
  copyVerified(original, join(target, "g1-receipt.json"), native.baselineReceiptSha256);
  copyVerified(headerReceipt, join(target, "headers.json"), g1.headers.sha256);
  copyVerified(join(g2, "compile-commands.json"), join(target, "compile-commands.json"), native.compileCommandsSha256);
  copyVerified(join(g2, "libspidermonkey_g2.a"), join(target, "libspidermonkey_g2.a"), native.librarySha256);
  copyVerified(join(g2, "native.json"), join(target, "g2-receipt.json"), digest(join(g2, "native.json")));
  const receipt = JSON.stringify({ schema: 1, origin: "reused G2 native inputs, not a new Mozilla build", baselineReceiptSha256: native.baselineReceiptSha256,
    g2ReceiptSha256: digest(join(g2, "native.json")), revision: g1.revision, patchSha256: native.patchSha256,
    librarySha256: native.librarySha256, compileCommandsSha256: native.compileCommandsSha256, headers: g1.headers, confdefsSha256: g1.confdefsSha256 }, null, 2) + "\n";
  const path = join(target, "native-inputs.json");
  if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), receipt, "Existing successor origin must not be relabeled");
  else writeFileSync(path, receipt);
  verifyEngineInputs(target);
}
if (import.meta.main) {
  const [baseline, g2, out] = process.argv.slice(2);
  assert(baseline && g2 && out, "Usage: prepare-engine-inputs.ts G1 G2 SUCCESSOR");
  prepareEngineInputs(baseline, g2, out);
}
