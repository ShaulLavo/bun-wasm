import assert from "node:assert/strict";
import { createRequire } from "node:module";
import processModule from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const names = ["process", "buffer", "fs", "fs/promises", "path", "module", "assert/strict"];
for (const name of names) {
  assert.equal(require.resolve(name), name);
  assert.equal(require.resolve(`node:${name}`), `node:${name}`);
  assert.equal(require(name), require(`node:${name}`));
}
for (const name of ["bun", "bun:jsc", "bun:test", "bun:sqlite", "ws", "node:test"]) {
  assert.equal(require.resolve(name), name);
}
assert.equal(require.resolve("./index.ts"), fileURLToPath(import.meta.url));
assert.equal(import.meta.resolve("process"), "node:process");
assert.equal(require("process"), processModule);
console.log("builtin resolution preserves public spelling and private identity");
