import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const path = process.argv[2];
assert(path, "smoke engine path is required");
const module = new WebAssembly.Module(readFileSync(path));
const production = WebAssembly.Module.imports(module).filter(({ module, name }) =>
  module === "env" && /^bun_core_(bind_engine|poll|idle|exit)$/.test(name));
assert.deepEqual(production, [], "raw smoke must not retain the production RUN driver");
assert(WebAssembly.Module.exports(module).some(({ name }) => name === "quickjs_link_smoke"));
console.log("PASS: smoke exports exclude production RUN imports");
