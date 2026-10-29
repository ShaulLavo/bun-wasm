import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureCases, loaderSource } from "./esm-loader-harness";
import { runCase } from "./esm-loader-run";

const loader = loaderSource();
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-esm-loader-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const name of fixtureCases()) {
  test(`esm loader: ${name} matches Node`, () => {
    const result = runCase(name, ["node"], scratch, loader);
    expect(result.actual).toBe(result.expected);
  });
}

function probe(source: string): void {
  const run = spawnSync("node", ["-e", `const assert = require("node:assert/strict"); const factory = ${loader}; (async () => { ${source} })().then(() => console.log("verified"), error => { console.error(error); process.exitCode = 1; });`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("verified\n");
}

test("record host: virtual names skip resolution and synthetic exports are snapshots", () => {
  probe(`
    let loads = 0, reads = 0;
    const exports = { value: 1, default: "ignored", __esModule: true, get getter() { reads++; return 3; } };
    const defaultValue = { separate: true };
    const loader = factory({
      resolve() { throw new Error("virtual eval name must not resolve"); },
      load(name) { assert.equal(name, "/[eval]"); loads++; return { namespace: exports, default: defaultValue }; },
      initMeta() { throw new Error("synthetic modules have no import.meta handoff"); },
    });
    const first = loader.importName("/[eval]");
    exports.value = 2;
    return Promise.all([first, loader.importName("/[eval]")]).then(([one, two]) => {
      assert.equal(one, two);
      assert.equal(one.value, 1);
      assert.equal(one.getter, 3);
      assert.equal(one.default, defaultValue);
      assert.deepEqual(Object.keys(one), ["default", "getter", "value"]);
      assert.equal(Object.getPrototypeOf(one), null);
      assert.equal(Object.isExtensible(one), false);
      assert.equal(loads, 1);
      assert.equal(reads, 1);
    });
  `);
});

test("record host: script dynamic imports defer loading and retain the referrer", () => {
  probe(`
    const events = [];
    const loader = factory({
      resolve(specifier, referrer) { events.push([specifier, referrer]); return "/lazy.mjs"; },
      load(name) { events.push(name); return { namespace: { answer: 42 }, default: undefined }; },
      initMeta() {},
    });
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, "__bunwasm_import").enumerable, false);
    const imported = __bunwasm_import("/entry.cjs")("./lazy.mjs");
    assert.deepEqual(events, []);
    return imported.then(namespace => {
      assert.equal(namespace.answer, 42);
      assert.deepEqual(events, [["./lazy.mjs", "/entry.cjs"], "/lazy.mjs"]);
      return loader.dynamicImport("./lazy.mjs", "/other.mjs");
    }).then(namespace => assert.equal(namespace.answer, 42));
  `);
});

test("record host: entry evaluation errors keep their identity on reimport", () => {
  probe(`
    const failure = { marker: "same thrown value" };
    let runs = 0;
    const record = { r: [], i: [], x: [], s: [], a: false, f: function* (api) {
      api.l({}); yield; yield; runs++; throw failure;
    } };
    const loader = factory({ resolve: specifier => specifier, load: () => ({ record }), initMeta() {} });
    const rejected = loader.importName("/broken.mjs");
    return rejected.catch(error => {
      assert.equal(error, failure);
      return loader.importName("/broken.mjs").catch(again => assert.equal(again, failure));
    }).then(() => assert.equal(runs, 1));
  `);
});

test("record host: import.meta is initialized once through the host", () => {
  probe(`
    let calls = 0;
    const record = { r: [], i: [], x: [], s: [], a: false, f: function* (api) {
      api.l({ url: () => api.meta.url }); yield; yield;
      assert.equal(api.meta, api.meta);
    } };
    const loader = factory({
      resolve: specifier => specifier,
      load: () => ({ record }),
      initMeta(name, meta) { calls++; assert.equal(name, "/meta.mjs"); meta.url = "file:///meta.mjs"; },
    });
    return loader.importName("/meta.mjs").then(namespace => {
      assert.equal(namespace.url, "file:///meta.mjs");
      assert.equal(calls, 1);
    });
  `);
});
