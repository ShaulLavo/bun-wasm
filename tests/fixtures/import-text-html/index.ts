import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const entry of ["default-first.mjs", "text-first.ts"]) {
  const child = Bun.spawnSync([process.execPath, "run", entry]);
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.equal(child.stdout.toString(), "order passes\n");
}
const first = await import("./default-first.mjs");
const second = await import("./text-first.ts");
const expected = readFileSync("page.html", "utf8");
assert.equal(first.page, expected);
assert.equal(second.page, expected);
assert.equal(first.ordinary, second.ordinary);
assert.equal(require("./page.html"), first.ordinary);
assert.equal(Object.prototype.toString.call(first.ordinary), "[object HTMLBundle]");
assert.equal(first.ordinary.index, join(import.meta.dir, "page.html"));
console.log("text and default HTML identities coexist in both orders");

const reexports = await import("./reexports.mjs");
assert.equal(reexports.page, expected);
const options = { with: { type: "text" } };
const one = import("./page.html", options);
const two = import("./page.html", options);
assert.notEqual(one, two);
options.with.type = "ignored";
const namespace = await one;
assert.equal(await two, namespace);
assert.equal(await import("./alias/../page.html", { with: { type: "text" } }), namespace);
assert.equal(reexports.pageNamespace, namespace);
assert.equal(await import("./namespace.mjs").then(module => module.namespace), namespace);
assert.notEqual(await import("./page.html"), namespace);
const commonjs = require("./dynamic.cjs");
assert.equal(await commonjs.load("./page.html", { with: { type: "text" } }), namespace);
const a = await import("./a/importer.mjs");
const b = await import("./b/importer.mjs");
assert.equal(a.default, "alpha\n");
assert.equal(b.default, "beta\n");
console.log("static, dynamic, aliases, re-exports and CommonJS share text namespaces");

const raw = "\uFEFF#!this is data\nquotes: \" \\ שלום 🌍\n";
writeFileSync("raw.html", raw);
assert.equal((await import("./raw.html", { with: { type: "text" } })).default, raw);
const data = await import("./side-effect.mjs", { with: { type: "text" } });
assert.equal(data.default, readFileSync("side-effect.mjs", "utf8"));
assert.equal(globalThis.textImportSideEffect, undefined);
assert.deepEqual((await import("./data.json")).default, { unchanged: true });
assert.equal(require("./ordinary.cjs").value, 42);
assert.equal(require.resolve("./page.html"), join(import.meta.dir, "page.html"));
assert.equal(import.meta.resolve("./page.html"), import.meta.url.replace(/index.ts$/, "page.html"));
console.log("raw UTF-8, BOM, shebang, JSON and ordinary CommonJS are preserved");

const events = [];
const failure = { exact: "rejection identity" };
const specifier = { toString() { events.push("coerce"); return "./page.html"; } };
const operation = import(specifier, { get with() { events.push("with"); return { get ignored() { events.push("ignored"); return "yes"; }, type: "text" }; } });
assert.deepEqual(events, ["coerce", "with", "ignored"]);
assert.equal(await operation, namespace);
for (const [specifier, options] of [
  [{ toString() { throw failure; } }, undefined],
  ["./page.html", { get with() { throw failure; } }],
  ["./page.html", { with: { get ignored() { throw failure; }, type: "text" } }],
]) {
  await assert.rejects(import(specifier, options), error => error === failure);
}
await assert.rejects(import(Symbol("no")), TypeError);
for (const options of [null, 1, { with: null }, { with: { type: 1 } }]) {
  await assert.rejects(import("./page.html", options), TypeError);
}
await assert.rejects(import("node:fs", { with: { type: "text" } }), TypeError);
await assert.rejects(import("./missing-static.mjs"), error => {
  assert.equal(error.name, "ResolveMessage");
  assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
  assert.equal(error.specifier, "./absent.html");
  assert.equal(error.referrer, join(import.meta.dir, "missing-static.mjs"));
  return true;
});
assert.equal((await import("./page.html", { with: { type: "text" } })).default, expected);
globalThis.importTextFailure = failure;
await assert.rejects(import("./throwing.mjs"), error => error === failure);
await assert.rejects(import("./throwing.mjs"), error => error === failure);
console.log("normalization, resolution and evaluation errors retain their identities");

for (const extension of ["ts", "js", "mjs"]) {
  await assert.rejects(import(`./location.${extension}`), error => {
    assert.match(error.stack, new RegExp(`location\\.${extension}:3[:)]`));
    return true;
  });
}
writeFileSync("page.html", "edited in a fresh process\n");
assert.equal((await import("./page.html", { with: { type: "text" } })).default, expected);
const fresh = Bun.spawnSync([process.execPath, "run", "fresh.ts"]);
assert.equal(fresh.exitCode, 0, fresh.stderr.toString());
assert.equal(fresh.stdout.toString(), "edited in a fresh process\n");
console.log("source maps and process-local cache lifetimes pass");
