import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { productionRequire } from "./module-compile-runtime.ts";

const [mode, argument, contract] = process.argv.slice(2);
assert(argument);
const directory = argument;
assert(mode === "native" || mode === "runtime" || mode === "runtime-host");
assert(contract === "next" || contract === "hooks");
const entry = join(directory, `${contract}.cjs`);
const target = join(directory, "webpack-package.json");
writeFileSync(target, '{"name":"webpack","marker":"private-next-webpack"}');

function nextSource(): string {
  copyFileSync(new URL("./fixtures/next-webpack-resolve-hook/require-hook.txt", import.meta.url), join(directory, "require-hook.cjs"));
  return `
    const hook = require('./require-hook.cjs');
    hook.addHookAliases([['webpack/package.json', ${JSON.stringify(target)}]]);
    const resolved = require.resolve('webpack/package.json');
    const loaded = require('webpack/package.json');
    module.exports = { resolved, loaded, sameCachedExport: loaded === require(resolved) };
  `;
}

function hooksSource(): string {
  mkdirSync(join(directory, "nested"), { recursive: true });
  writeFileSync(join(directory, "nested", "value.json"), '{"marker":"nested-parent"}');
  return `
    const Module = require('node:module');
    const original = Module._resolveFilename;
    const options = { paths: [${JSON.stringify(directory)}] };
    const failure = new Error('resolver-sentinel');
    const observed = [];
    Module._resolveFilename = function(request, parent, isMain, passedOptions) {
      if (request === 'resolver-failure') throw failure;
      if (request === 'virtual-webpack') {
        observed.push({ receiver: this === Module, parent: parent === module, instance: parent instanceof Module,
          filename: parent.filename, paths: Array.isArray(parent.paths), isMain, options: passedOptions === options });
        return original.call(this, ${JSON.stringify(target)}, parent, isMain, passedOptions);
      }
      if (request === 'virtual-nested') return original.call(this, './value.json', parent, isMain, passedOptions);
      return original.apply(this, arguments);
    };
    const resolved = require.resolve('virtual-webpack', options);
    const loaded = require('virtual-webpack');
    const created = Module.createRequire(${JSON.stringify(join(directory, "nested", "entry.cjs"))});
    let sameError = false;
    try { require('resolver-failure'); } catch (error) { sameError = error === failure; }
    const nested = created('virtual-nested');
    const builtinSpelling = [require.resolve('process'), require.resolve('node:process')];
    Module._resolveFilename = original;
    module.exports = { resolved, loaded, observed, nested, sameError, builtinSpelling,
      sameCachedExport: require(resolved) === loaded };
  `;
}

writeFileSync(entry, contract === "next" ? nextSource() : hooksSource());
const result: unknown = mode === "native" ? createRequire(entry)(entry) : productionRequire(entry, undefined, mode === "runtime-host");
assert(result && typeof result === "object");
assert("resolved" in result && "loaded" in result && "sameCachedExport" in result);
assert.equal(result.resolved, target);
assert.deepEqual(JSON.parse(JSON.stringify(result.loaded)), { name: "webpack", marker: "private-next-webpack" });
assert.equal(result.sameCachedExport, true);
if (contract === "hooks") {
  assert("observed" in result && "nested" in result && "sameError" in result && "builtinSpelling" in result);
  assert.deepEqual(JSON.parse(JSON.stringify(result.observed)), [
    { receiver: true, parent: true, instance: true, filename: entry, paths: true, isMain: false, options: true },
    { receiver: true, parent: true, instance: true, filename: entry, paths: true, isMain: false, options: false },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.nested)), { marker: "nested-parent" });
  assert.equal(result.sameError, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.builtinSpelling)), ["process", "node:process"]);
}
console.log(JSON.stringify({ mode, contract, status: "pass", fixtureBytes: readFileSync(entry).byteLength }));
