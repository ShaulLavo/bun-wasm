import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const Module = require("node:module");
for (const name of ["process", "node:process", "buffer", "node:buffer", "fs", "node:fs", "path", "node:path"]) {
  assert.equal(require.resolve(name), name);
  assert.equal(Module._resolveFilename(name, new Module("/virtual.cjs")), name);
}
console.log("builtin resolution preserves requested spelling");
const filename = join(import.meta.dirname, "nested", "virtual.cjs");
const parent = new Module(join(import.meta.dirname, "parent.cjs"));
const compiled = new Module(filename, parent);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(dirname(filename));
const originalPaths = compiled.paths;
const originalRequire = Module.prototype.require;
const seen: string[] = [];
Module.prototype.require = function (specifier: string) {
  seen.push(specifier);
  return originalRequire.call(this, specifier);
};
let returned: unknown;
try {
  returned = compiled._compile(`
    const assert = require("node:assert/strict");
    assert.equal(this, exports);
    assert.equal(arguments.length, 5);
    assert.equal(module.exports, exports);
    exports.relative = require("./value.json").value;
    exports.package = require("compile-package").value;
    exports.resolved = require.resolve("./value.json");
    exports.filename = __filename;
    exports.dirname = __dirname;
    exports.sameModule = module;
    exports.unicode = "😀";
    exports.promise = import("./value.ts");
    exports.literal = "import('./must-not-load.ts')";
    exports.template = \`import('./must-not-load.ts')\`;
    // import("./must-not-load.ts")
    return 23;
  `, filename);
} finally {
  Module.prototype.require = originalRequire;
}
assert.equal(returned, 23);
assert.equal(compiled.exports.relative, 42);
assert.equal(compiled.exports.package, 17);
assert.equal(compiled.exports.resolved, join(dirname(filename), "value.json"));
assert.equal(compiled.exports.filename, filename);
assert.equal(compiled.exports.dirname, dirname(filename));
assert.equal(compiled.exports.sameModule, compiled);
assert.equal(compiled.parent, parent);
assert.equal(compiled.filename, filename);
assert.equal(compiled.paths, originalPaths);
assert.equal(compiled.loaded, false);
assert.equal(require.cache[filename], undefined);
assert.deepEqual(seen, ["node:assert/strict", "./value.json", "compile-package"]);
assert.equal((await compiled.exports.promise).default, "dynamic value");
assert.equal(compiled.exports.literal, "import('./must-not-load.ts')");
assert.equal(compiled.exports.template, compiled.exports.literal);
console.log("compile source, wrapper, require, imports and metadata");

const replaced = new Module(filename, parent);
assert.equal(replaced._compile("module.exports = { value: 9 };", filename), undefined);
assert.deepEqual(replaced.exports, { value: 9 });
const strict = new Module(filename, parent);
strict._compile('"use strict"; module.exports = function () { return this; }();', filename);
assert.equal(strict.exports, undefined);
for (const source of ["\ufeffmodule.exports = 5;", "#!/usr/bin/env node\nmodule.exports = 5;"]) {
  const prefixed = new Module(filename, parent);
  prefixed._compile(source, filename);
  assert.equal(prefixed.exports, 5);
}
for (const separator of ["\u2028", "\u2029"]) {
  const prefixed = new Module(filename, parent);
  prefixed._compile(`#!ignored${separator}module.exports = 5;`, filename);
  assert.equal(prefixed.exports, 5);
}
const shadowed = new Module(filename, parent);
shadowed._compile('const globalThis = null; module.exports = import("./value.ts");', filename);
assert.equal((await shadowed.exports).default, "dynamic value");
console.log("exports replacement, directives, prefixes and shadowed import binding");

const broken = new Module(filename, parent);
assert.throws(() => broken._compile("const invalid: number = 1;", filename), SyntaxError);
assert.throws(() => broken._compile('throw new Error("compile failure");', filename), /compile failure/);
assert.equal(broken.loaded, false);
assert.equal(require.cache[filename], undefined);
console.log("syntax and runtime errors propagate without marking loaded");
