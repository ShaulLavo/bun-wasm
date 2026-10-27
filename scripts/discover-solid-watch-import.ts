import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = process.argv[2];
assert.ok(cache, "Usage: bun scripts/discover-solid-watch-import.ts REGISTRY_CACHE");
const index: unknown = JSON.parse(readFileSync(join(cache, "index.json"), "utf8"));
assert.ok(index && typeof index === "object");
const steps = [
  ["vinxi", "0.5.8", "lib/build.js", 'const sh = await import("../runtime/sh.js")'],
  ["vinxi", "0.5.8", "runtime/sh.js", 'export { $ as default } from "dax-sh"'],
  ["dax-sh", "0.43.2", "esm/mod.js", 'import { Deno } from "@deno/shim-deno"'],
  ["@deno/shim-deno", "0.19.2", "dist/index.mjs", 'import { watch } from "fs/promises"'],
] as const;
const rows = steps.map(([name, version, file, statement]) => {
  const basename = name.slice(name.lastIndexOf("/") + 1);
  const request = `/${name}/-/${basename}-${version}.tgz`;
  assert.ok(request in index);
  const entry: unknown = Reflect.get(index, request);
  assert.ok(entry && typeof entry === "object" && "sha256" in entry && typeof entry.sha256 === "string");
  const archive = join(cache, "objects", entry.sha256);
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), entry.sha256);
  const source = execFileSync("tar", ["-xOzf", archive, `package/${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const offset = source.indexOf(statement);
  assert.ok(offset >= 0, `Missing import in ${name}/${file}`);
  return { name, version, file, line: source.slice(0, offset).split("\n").length, statement, request, sha256: entry.sha256 };
});
console.log(JSON.stringify(rows, null, 2));
