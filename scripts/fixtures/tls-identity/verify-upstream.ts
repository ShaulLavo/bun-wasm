import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const pin = "9510e74152073d850a18758ca41114d8f214ffa6";
function objectDatabaseDirectory(): string {
  const value = process.argv[2];
  if (!value) throw new Error("Usage: verify-upstream.ts EXISTING_BUN_OBJECT_DATABASE_CHECKOUT");
  return value;
}
const directory = objectDatabaseDirectory();
const manifest: unknown = JSON.parse(readFileSync(new URL("./upstream.json", import.meta.url), "utf8"));
if (!isRecord(manifest) || manifest.commit !== pin || !Array.isArray(manifest.files)) throw new Error("Invalid pinned identity source manifest");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifyFile(file: unknown): void {
  if (!isRecord(file) || typeof file.path !== "string" || typeof file.blob !== "string" || typeof file.sha256 !== "string" || typeof file.bytes !== "number") throw new Error("Invalid upstream file record");
  const bytes = execFileSync("git", ["-C", directory, "show", `${pin}:${file.path}`]);
  const blob = execFileSync("git", ["-C", directory, "rev-parse", `${pin}:${file.path}`], { encoding: "utf8" }).trim();
  assert.equal(blob, file.blob, file.path);
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
}

for (const file of manifest.files) verifyFile(file);
const source = execFileSync("git", ["-C", directory, "show", `${pin}:test/js/node/test/parallel/test-tls-check-server-identity.js`], { encoding: "utf8" });
const marker = "const tests = ";
const start = source.indexOf(marker) + marker.length;
const end = source.indexOf("\n];", start) + 2;
assert.ok(start >= marker.length && end > start, "pinned pure-test array exists");
const upstream: unknown = runInNewContext(source.slice(start, end), {}, { timeout: 1000 });
assert.ok(Array.isArray(upstream), "pinned test array");
const mapped = upstream.map((item: unknown, index: number) => {
  if (!isRecord(item)) throw new Error(`Invalid pinned pure case ${index}`);
  return { name: `upstream-${index}`, hostname: item.host, cert: item.cert, reason: item.error };
});
const fixture = readFileSync(new URL("./upstream-cases.json", import.meta.url), "utf8");
assert.equal(fixture, JSON.stringify(mapped, null, 2) + "\n", "all pure upstream inputs and reasons retain their pinned values");
console.log(JSON.stringify({ commit: pin, files: manifest.files.length, pureCases: mapped.length, runtimeProof: false }));
