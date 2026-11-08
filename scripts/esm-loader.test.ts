import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureCases, withImportRequests } from "./esm-loader-harness";
import { runCase } from "./esm-loader-run";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-esm-loader-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const loaderPath = join(scratch, "esm_loader.js");
execFileSync("node", ["--disable-warning=ExperimentalWarning", join(import.meta.dir, "transpile-runtime.ts"),
  join(import.meta.dir, "../crates/bunwasm-runtime/src/js/esm_loader.ts"), loaderPath]);
const loader = withImportRequests(`require("node:vm").runInThisContext(${JSON.stringify(readFileSync(loaderPath, "utf8"))})`);

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
    const record = { r: [], i: [], x: [], s: [], e: [], a: false, f: function* (api) {
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
    const record = { r: [], i: [], x: [], s: [], e: [["url", "url"]], a: false, f: function* (api) {
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

test.each(["null", "undefined", '"nonempty text"', "false", "0", '""'])(
  "record host: primitive synthetic exports preserve %s after production type erasure",
  value => {
    probe(`
      const value = ${value};
      const loader = factory({
        resolve: specifier => specifier,
        load: () => ({ namespace: value, default: value }),
        initMeta() {},
      });
      return loader.importName("/primitive.cjs").then(namespace => {
        assert.equal(namespace.default, value);
        assert.deepEqual(Object.keys(namespace), ["default"]);
      });
    `);
  },
);

test("record host: object and function snapshots preserve separately supplied falsy defaults", () => {
  probe(`
    function exported() {}
    exported.named = 42;
    exported.default = "ignored";
    const object = { named: 42, default: "ignored", __esModule: true };
    for (const value of [undefined, null, false, 0, -0, "", NaN]) {
      for (const source of [object, exported]) {
        const loader = factory({
          resolve: specifier => specifier,
          load: () => ({ namespace: source, default: value }),
          initMeta() {},
        });
        const namespace = await loader.importName("/separate.cjs");
        assert.equal(namespace.default, value);
        assert.equal(namespace.named, 42);
        assert.deepEqual(Object.keys(namespace), ["default", "named"]);
      }
    }
  `);
});

// ECMA-262 10.4.6.11 orders namespace keys by UTF-16 code units, integer-like names
// included. V8's own namespaces list integer-like names first, so this is not a fixture
// compared with Node.
test("record host: namespace keys follow code-unit order for integer-like names", () => {
  probe(`
    const record = { r: [], i: [], x: [], s: [], e: [["2", "two"], ["b", "b"], ["10", "ten"]], a: false, f: function* (api) {
      const ten = 10, two = 2;
      api.l({ two: () => two, b: () => "b", ten: () => ten }); yield; yield;
    } };
    const loader = factory({ resolve: specifier => specifier, load: () => ({ record }), initMeta() {} });
    const namespace = await loader.importName("/keys.mjs");
    assert.deepEqual(Reflect.ownKeys(namespace), ["10", "2", "b", Symbol.toStringTag]);
    assert.deepEqual(Object.keys(namespace), ["10", "2", "b"]);
    assert.equal(namespace["10"], 10);
  `);
});

test("record host: a body runs without a receiver", () => {
  probe(`
    let receiver = "unset";
    const record = { r: [], i: [], x: [], s: [], e: [], a: false, f: function* (api) {
      "use strict";
      api.l({}); yield; yield; receiver = this;
    } };
    const loader = factory({ resolve: specifier => specifier, load: () => ({ record }), initMeta() {} });
    await loader.importName("/this.mjs");
    assert.equal(receiver, undefined);
  `);
});

test("record host: built-ins changed after the loader exists do not reach module loading", () => {
  probe(`
    const record = (body) => ({ r: ["./dep.mjs"], i: [[0, "x"]], x: [], s: [], e: [], a: true, f: body });
    const records = {
      "/main.mjs": record(function* (api) { api.l({}); yield; const dep = api.n[0], ns = api.ns(0); yield; yield null; globalThis.seen = [dep.x, ns.x, Object.keys(ns).join()]; }),
      "/dep.mjs": { r: [], i: [], x: [], s: [], e: [["x", "x"]], a: false, f: function* (api) { const x = 1; api.l({ x: () => x }); yield; yield; } },
    };
    const loader = factory({ resolve: specifier => "/" + specifier.slice(2), load: name => ({ record: records[name] }), initMeta() {} });
    const saved = { push: Array.prototype.push, map: Array.prototype.map, get: Map.prototype.get, then: Promise.prototype.then };
    const settled = new Promise(resolve => { saved.done = resolve; });
    // The probe harness has attached its own reaction to this function's promise by now.
    await new Promise(resolve => setTimeout(resolve, 0));
    Array.prototype.push = Array.prototype.map = Map.prototype.get = () => { throw new Error("patched"); };
    Object.prototype.get = Object.prototype.has = Object.prototype.value = () => { throw new Error("polluted"); };
    Promise.prototype.then = function () { throw new Error("patched then"); };
    try {
      saved.then.call(loader.importName("/main.mjs"), saved.done, error => saved.done(error));
    } finally {
      Object.assign(Array.prototype, { push: saved.push, map: saved.map });
      Map.prototype.get = saved.get;
      delete Object.prototype.get; delete Object.prototype.has; delete Object.prototype.value;
    }
    // Reactions the loader queued run with the patched \`then\` still in place.
    await new Promise(resolve => setTimeout(resolve, 0));
    Promise.prototype.then = saved.then;
    const outcome = await settled;
    assert.equal(outcome instanceof Error ? outcome.message : outcome[Symbol.toStringTag], "Module");
    assert.deepEqual(globalThis.seen, [1, 1, "x"]);
  `);
});

test("record host: an exited host loads, links and resumes nothing", () => {
  probe(`
    let running = true, loads = 0, resumed = false, tracked = 0;
    const records = {
      "/wait.mjs": { r: [], i: [], x: [], s: [], e: [], a: true, f: function* (api) { api.l({}); yield; yield; yield new Promise(resolve => setTimeout(resolve, 5)); resumed = true; } },
      "/later.mjs": { r: [], i: [], x: [], s: [], e: [], a: false, f: function* (api) { api.l({}); yield; yield; } },
    };
    const loader = factory({
      resolve: specifier => specifier,
      load: name => { loads++; return { record: records[name] }; },
      initMeta() {},
      active: () => running,
      track: operation => { tracked++; return operation; },
    });
    const waiting = loader.importName("/wait.mjs");
    const dynamic = loader.dynamicImport("/later.mjs", "/wait.mjs");
    assert.equal(tracked, 1);
    running = false;
    const settled = await Promise.race([waiting.then(() => "settled", () => "rejected"), dynamic.then(() => "settled", () => "rejected"), new Promise(resolve => setTimeout(() => resolve("pending"), 30))]);
    assert.equal(settled, "pending");
    assert.equal(resumed, false);
    assert.equal(loads, 1);
    assert.equal(await Promise.race([loader.importName("/later.mjs").then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("pending"), 10))]), "pending");
    assert.equal(loads, 1);
  `);
});

// The source review's exit probes: a body that exits stops its later siblings, the root and
// the namespace's publication; an exit before an import makes no native call; a resolved
// evaluation published after the exit, and a top-level await rejected after it, settle nothing.
test("record host: an exit inside a body starts no later module and publishes nothing", () => {
  probe(`
    let running = true, loads = 0;
    const events = [];
    const empty = { r: [], i: [], x: [], s: [], e: [], a: false };
    const modules = {
      root: { ...empty, r: ["exit", "sibling"], f: function* (api) { api.l({}); yield; yield; events.push("root"); } },
      exit: { ...empty, f: function* (api) { api.l({}); yield; yield; running = false; events.push("exit"); } },
      sibling: { ...empty, f: function* (api) { api.l({}); yield; yield; events.push("late sibling"); } },
    };
    const loader = factory({ resolve: x => x, load: key => { loads++; return { record: modules[key] }; }, initMeta() {}, active: () => running });
    loader.importName("root").then(() => events.push("late namespace publication"), () => events.push("late rejection"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(events, ["exit"]);
    loads = 0;
    loader.importName("other").then(() => events.push("published"), () => events.push("rejected"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(loads, 0);
    assert.deepEqual(events, ["exit"]);
  `);
});

test("record host: an exit after evaluation or during top-level await publishes nothing", () => {
  probe(`
    let running = true;
    const events = [];
    const empty = { r: [], i: [], x: [], s: [], e: [], a: false };
    const modules = {
      done: { ...empty, f: function* (api) { api.l({}); yield; yield; events.push("done body"); } },
      late: { ...empty, a: true, f: function* (api) { api.l({}); yield; yield; yield null; running = false; throw new Error("after exit"); } },
    };
    const loader = factory({ resolve: x => x, load: key => ({ record: modules[key] }), initMeta() {}, active: () => running });
    const done = loader.importName("done");
    running = false;
    done.then(() => events.push("published"), () => events.push("rejected"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(events, ["done body"]);
    running = true;
    loader.importName("late").then(() => events.push("late published"), () => events.push("late rejected"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(events, ["done body"]);
  `);
});

// Two exports of one local are one binding (ECMA-262 16.2.1.6.3): star exports that reach it
// through both names are not ambiguous. Equal values in distinct locals still are.
test("record host: export aliases of one local resolve to one binding", () => {
  probe(`
    const record = (fields) => ({ r: [], i: [], x: [], s: [], e: [], a: false, ...fields });
    const modules = {
      origin: record({ e: [["a", "local"], ["b", "local"], ["c", "other"]], f: function* (api) { let local = 1, other = 1; api.l({ local: () => local, other: () => other }); yield; yield; globalThis.bump = () => local++; } }),
      one: record({ r: ["origin"], x: [["x", 0, "a"], ["y", 0, "a"]], f: function* (api) { api.l({}); yield; yield; } }),
      two: record({ r: ["origin"], x: [["x", 0, "b"], ["y", 0, "c"]], f: function* (api) { api.l({}); yield; yield; } }),
      hub: record({ r: ["one", "two"], s: [0, 1], f: function* (api) { api.l({}); yield; yield; } }),
    };
    const loader = factory({ resolve: x => x, load: key => ({ record: modules[key] }), initMeta() {} });
    const hub = await loader.importName("hub");
    assert.deepEqual(Object.keys(hub), ["x"]);
    assert.equal(hub.x, 1);
    globalThis.bump();
    assert.equal(hub.x, 2);
  `);
});
