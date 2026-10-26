import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { productionModule, productionRequire, type ModuleConstructor } from "./module-compile-runtime.ts";

const mode = process.argv[2];
const directory = process.argv[3];
assert(directory);
const filename = join(directory, "config.cjs");
const Module: ModuleConstructor = mode === "runtime" ? productionModule(filename) : createRequire(import.meta.url)("node:module");
const isBun = mode !== "runtime" && !!process.versions.bun;
writeFileSync(join(directory, "child.cjs"), 'module.exports = { marker: "child" };');
writeFileSync(join(directory, "data.json"), '{"answer":42}');

function compile(source: string, file = filename) {
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(dirname(file));
  const result = module._compile(source, file);
  return { module, result };
}

function syntaxError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "name" in error && error.name === "SyntaxError";
}

function nextConfigContract() {
  const helperFile = join(directory, "next-require-hook.cjs");
  writeFileSync(helperFile, readFileSync(new URL("./fixtures/module-compile/next-require-hook.txt", import.meta.url)));
  const helper = mode === "runtime" ? productionRequire(helperFile) : createRequire(helperFile)(helperFile);
  assert(typeof helper.requireFromString === "function");
  assert.deepEqual(JSON.parse(JSON.stringify(helper.requireFromString('module.exports = { reactStrictMode: true, nested: require("node:path").basename(__filename) };', join(dirname(filename), "next.config.ts")))), { reactStrictMode: true, nested: "next.config.ts" });
}

if (process.argv[4] === "next") {
  nextConfigContract();
  console.log("cached Next requireFromString passed");
  process.exit(0);
}

const wrapper = compile(`
exports.initial = true;
module.exports = {
  receiver: this === exports,
  arguments: arguments.length,
  filename: __filename,
  dirname: __dirname,
  sameModule: arguments[2] === module,
  sameExports: arguments[0] === exports,
  child: require('./child.cjs').marker,
  json: require('./data.json').answer,
  resolved: require.resolve('./child.cjs'),
  cache: require.cache[require.resolve('./child.cjs')].exports === require('./child.cjs'),
  uncached: require.cache[__filename] === undefined
};
return 23;
`);
assert.deepEqual(JSON.parse(JSON.stringify(wrapper.module.exports)), {
  receiver: !isBun, arguments: 5, filename, dirname: directory, sameModule: true, sameExports: true,
  child: "child", json: 42, resolved: join(directory, "child.cjs"), cache: true, uncached: true,
});
assert.equal(wrapper.result, isBun ? undefined : 23);
assert.equal(wrapper.module.loaded, isBun);
assert.equal(Module._cache[filename], undefined);
assert.equal(compile('exports.old = true; module.exports = { replacement: true }; exports.late = true;').module.exports.replacement, true);
assert.equal(compile('(function(exports, require, module, __filename, __dirname, meta) { module.exports.wrong = true; });').module.exports.wrong, undefined);
assert.equal(compile('\ufeffmodule.exports = { bom: true };').module.exports.bom, true);
assert.equal(compile('module.exports = { ok: true }; // trailing comment').module.exports.ok, true);
assert.equal(compile('module.exports = require("node:module")._cache === require.cache;').module.exports, true);
assert.throws(() => compile('module.exports = ;'), syntaxError);
if (!isBun) assert.throws(() => compile('}); globalThis.escaped = true; (function() {'), syntaxError);
const state = new Module(filename);
state.exports = { untouched: true };
assert.throws(() => state._compile('exports.changed = true; const broken = ;', filename), syntaxError);
assert.deepEqual(state.exports, { untouched: true });
assert.throws(() => compile('throw new Error("compile-sentinel")', join(directory, "reported-filename.cjs")), error => {
  assert(error && typeof error === "object" && "message" in error && "stack" in error);
  assert.equal(error.message, "compile-sentinel");
  assert.match(String(error.stack), /reported-filename\.cjs/);
  return true;
});
const sentinel = new Module(filename);
sentinel.exports = { sentinel: {} };
assert.throws(() => sentinel._compile('throw exports.sentinel;', filename), error => error === sentinel.exports.sentinel);
const repeat = new Module(filename);
repeat._compile('exports.one = 1;', filename);
repeat._compile('exports.two = 2;', filename);
assert.deepEqual(repeat.exports, { one: 1, two: 2 });

nextConfigContract();
console.log(JSON.stringify({ mode, engine: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, wrapper: wrapper.module.exports, returnValue: wrapper.result ?? null, loaded: wrapper.module.loaded, nextConfig: "passed" }));
