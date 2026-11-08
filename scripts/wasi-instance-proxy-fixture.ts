import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const upstream = {
  package: "@emnapi/wasi-threads", version: "2.2.0",
  archiveSha256: "f4c934b40a8a60763115a1da4e570fc8f2a549f9c0fac468c6a91169a154e110",
  sourceSha256: "317e0c864c7d454c245f5053471f3c9148bfb3b9149c1f18b5f2ad0c24f0e92f",
  fixtureSha256: "d91d962d2637e46e64614a596bf83036f13d2d87650ed1626753785614eed891",
};
const digest = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
export function proxyFixture(source: string): string {
  assert.equal(digest(source), upstream.sourceSha256, "Changed pinned wasi-threads source");
  const start = source.indexOf("const kIsProxy = Symbol('kIsProxy');");
  const end = source.indexOf("\n//#endregion src/proxy.ts", start);
  assert.ok(start >= 0 && end > start, "Missing upstream proxy region");
  const result = "// Generated from @emnapi/wasi-threads 2.2.0 src/proxy.ts; MIT license in wasi-threads-LICENSE.txt.\n" + source.slice(start, end) + "\nexport { createInstanceProxy };\n";
  assert.equal(digest(result), upstream.fixtureSha256);
  return result;
}

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) throw new Error("Pass the exact emnapi-wasi-threads-2.2.0.tgz input");
  const path = resolve(input);
  assert.equal(digest(readFileSync(path)), upstream.archiveSha256, "Changed pinned package archive");
  const source = execFileSync("tar", ["-xOf", path, "package/dist/wasi-threads.js"], { encoding: "utf8" });
  const license = execFileSync("tar", ["-xOf", path, "package/LICENSE"]);
  writeFileSync(new URL("../tests/fixtures/shared-wasm-memory/instance-proxy.js", import.meta.url), proxyFixture(source));
  writeFileSync(new URL("../tests/fixtures/shared-wasm-memory/wasi-threads-LICENSE.txt", import.meta.url), license);
}
