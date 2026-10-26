import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { productionModule, productionRequire, type ModuleConstructor } from "./module-compile-runtime.ts";

const mode = process.argv[2];
const argument = process.argv[3];
assert(argument);
const directory = argument;
const filename = join(directory, "config.cjs");
const Module: ModuleConstructor = mode === "runtime" ? productionModule(filename) : createRequire(import.meta.url)("node:module");
const isBun = mode !== "runtime" && !!process.versions.bun;
writeFileSync(join(directory, "child.cjs"), 'module.exports = { marker: "child" };');
writeFileSync(join(directory, "data.json"), '{"answer":42}');
mkdirSync(join(directory, "node_modules/config-dependency"), { recursive: true });
writeFileSync(join(directory, "node_modules/config-dependency/package.json"), '{"main":"index.json"}');
writeFileSync(join(directory, "node_modules/config-dependency/index.json"), '{"answer":42}');

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
  assert.deepEqual(JSON.parse(JSON.stringify(helper.requireFromString('module.exports = { reactStrictMode: true, name: require("node:path").basename(__filename) };', join(dirname(filename), "next.config.ts")))), { reactStrictMode: true, name: "next.config.ts" });
}

if (process.argv[4] === "next") {
  nextConfigContract();
  console.log("cached Next requireFromString passed");
  process.exit(0);
}

function hashbangSeparatorsContract() {
  for (const separator of ["\u2028", "\u2029"]) {
    assert.equal(compile(`#!node${separator}module.exports = 42;`).module.exports, 42);
  }
}

function sourceLocationsContract() {
  for (const [source, line] of [['throw new Error("line-sentinel")', 1], ['\n\nthrow new Error("line-sentinel")', 3]] satisfies [string, number][]) {
    assert.throws(() => compile(source), error => {
      assert(error && typeof error === "object" && "stack" in error);
      assert(String(error.stack).includes(`${filename}:${line}:7`), String(error.stack));
      return true;
    });
  }
}

function syntaxFilenameContract() {
  const state = new Module(filename);
  state.exports = { untouched: true };
  assert.throws(() => state._compile('exports.changed = true; const broken = ;', filename), error => {
    assert(syntaxError(error));
    assert(error && typeof error === "object" && "stack" in error);
    assert(String(error.stack).includes(filename), String(error.stack));
    return true;
  });
  assert.deepEqual(state.exports, { untouched: true });
  assert.throws(() => compile('}); globalThis.escaped = true; (function() {'), syntaxError);
  assert.equal(compile('module.exports = typeof globalThis.escaped;').module.exports, "undefined");
}

const focusedContracts: Record<string, () => void> = {
  hashbang: hashbangSeparatorsContract,
  locations: sourceLocationsContract,
  syntax: syntaxFilenameContract,
};
const focused = focusedContracts[process.argv[4] ?? ""];
if (focused) {
  focused();
  console.log(`${process.argv[4]} contract passed`);
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
  package: require("config-dependency").answer,
  resolved: require.resolve('./child.cjs'),
  cache: require.cache[require.resolve('./child.cjs')].exports === require('./child.cjs'),
  uncached: require.cache[__filename] === undefined
};
return 23;
`);
assert.deepEqual(JSON.parse(JSON.stringify(wrapper.module.exports)), {
  receiver: !isBun, arguments: 5, filename, dirname: directory, sameModule: true, sameExports: true,
  child: "child", json: 42, package: 42, resolved: join(directory, "child.cjs"), cache: true, uncached: true,
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
if (isBun) assert.throws(() => compile('#!/usr/bin/node\nmodule.exports = { hashbang: true };'), syntaxError);
if (!isBun) assert.equal(compile('#!/usr/bin/node\nmodule.exports = { hashbang: true };').module.exports.hashbang, true);
if (!isBun) assert.throws(() => compile('\ufeff#!/usr/bin/node\nmodule.exports = { hashbang: true };'), syntaxError);
let coercions = 0;
const invalid = { get toString() { coercions++; return () => "module.exports = {};"; } };
const checked = new Module(filename);
if (mode === "runtime") assert.throws(() => Reflect.apply(checked._compile, checked, [invalid, filename]));
if (mode === "runtime") assert.throws(() => Reflect.apply(checked._compile, checked, ["", invalid]));
assert.equal(coercions, 0);
const once = compile('exports.calls = (exports.calls || 0) + 1;');
assert.equal(once.module.exports.calls, 1);
if (!isBun) {
  const delegated = new Module(filename);
  let requireCalls = 0;
  delegated.require = specifier => { requireCalls++; return specifier; };
  delegated._compile('module.exports = { value: require("virtual") };', filename);
  assert.equal(delegated.exports.value, "virtual");
  assert.equal(requireCalls, 1);
}
const repeat = new Module(filename);
repeat._compile('exports.one = 1;', filename);
repeat._compile('exports.two = 2;', filename);
assert.deepEqual(JSON.parse(JSON.stringify(repeat.exports)), { one: 1, two: 2 });

nextConfigContract();
if (mode === "runtime") {
  const compiledFile = join(directory, "compiled-six.cjs");
  writeFileSync(compiledFile, "");
  const six = productionRequire(compiledFile, '(function(exports, require, module, __filename, __dirname, $Bun_import_meta) { module.exports = { count: arguments.length, filename: $Bun_import_meta.path, directory: $Bun_import_meta.dir, receiver: this === exports }; })');
  assert.deepEqual(JSON.parse(JSON.stringify(six)), { count: 6, filename: compiledFile, directory, receiver: true });
  compile('globalThis.Function = function() { throw new Error("untrusted Function"); };');
  assert.equal(compile('module.exports.trusted = true;').module.exports.trusted, true);
}
console.log(JSON.stringify({ mode, engine: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, wrapper: wrapper.module.exports, returnValue: wrapper.result ?? null, loaded: wrapper.module.loaded, nextConfig: "passed" }));
