import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loaderSource } from "../../scripts/esm-loader-harness.ts";
import { createModuleRecords, type LoaderFactory, type ModuleRecord, type RecordHost, type Then } from "../src/module-records.ts";

// The runtime's record loader, as EngineHost gets it from the wasm (`polyfillSource("esm_loader")`).
// oxlint-disable-next-line no-eval -- Evaluates the loader factory like the engine host does.
const factory = (0, eval)(`(${loaderSource()})`) as LoaderFactory;

type Body = (api: { l(getters: Record<string, () => unknown>): void; n: Record<string, unknown>[] }) => Generator<unknown, void, unknown>;
const esm = (requests: string[], f: Body, imports: [number, string][] = [], exports: [string, string][] = []): ModuleRecord => ({ r: requests, i: imports, x: [], s: [], e: exports, a: false, f: f as ModuleRecord["f"] });
const then = Function.prototype.call.bind(Promise.prototype.then) as Then;

/**
 * A host whose ES modules are hand-written records and whose CommonJS modules are `cjs`,
 * run once each as `require`'s cache would. `natives` counts calls into the host.
 */
function host(modules: Record<string, ModuleRecord>, cjs: Record<string, () => unknown>, active = () => true) {
  const ran: string[] = [];
  const natives: string[] = [];
  const cache = new Map<string, unknown>();
  const recordHost: RecordHost = {
    record: key => { natives.push(`record ${key}`); return key in modules ? { format: "esm", record: key } : { format: "cjs" }; },
    evaluate: (code, _key, done) => { queueMicrotask(() => done(modules[code]!)); },
    handoff: key => {
      natives.push(`handoff ${key}`);
      if (!cache.has(key)) { ran.push(key); cache.set(key, cjs[key]!()); }
      const value = cache.get(key);
      return { value, default: value };
    },
    keys: value => value !== null && typeof value === "object"
      ? Object.keys(value).filter(key => key !== "default" && key !== "__esModule" && /^[\p{L}\p{N}_$]+$/u.test(key))
      : [],
    initMeta() {},
    resolve: specifier => { natives.push(`resolve ${specifier}`); return specifier; },
    active,
    track: operation => operation,
  };
  return { records: createModuleRecords(recordHost, factory, then), ran, natives, cache };
}

const pending = <T>(promise: Promise<T>) => Promise.race([promise.then(() => "settled", () => "rejected"), new Promise(resolve => setTimeout(() => resolve("pending"), 20))]);

test("a CommonJS module's named exports are read when it evaluates, not when it loads", async () => {
  const reads: string[] = [];
  const exports = { get named() { reads.push("named"); return "value"; }, plain: 1 };
  let seen: unknown;
  const { records, ran } = host({
    "/main.mjs": esm(["/mutate.mjs", "/lib.cjs"], function* (api) { api.l({}); yield; const lib = api.n[1]!; yield; seen = [lib.named, lib.plain, lib.default === exports]; }, [[1, "named"], [1, "plain"], [1, "default"]]),
    "/mutate.mjs": esm([], function* (api) { api.l({}); yield; yield; reads.push("mutate"); exports.plain = 2; }),
  }, { "/lib.cjs": () => exports });
  await records.importKey("/main.mjs");
  expect(ran).toEqual(["/lib.cjs"]);
  expect(reads).toEqual(["mutate", "named"]);
  expect(seen).toEqual(["value", 2, true]);
});

test("a link error comes before any CommonJS export getter runs, and a retry reuses the required module", async () => {
  const reads: string[] = [];
  const bodies: string[] = [];
  const exports = { get named() { reads.push("named"); return 1; } };
  const modules: Record<string, ModuleRecord> = {
    "/main.mjs": esm(["/lib.cjs", "/dep.mjs"], function* (api) { api.l({}); yield; const lib = api.n[0]!; yield; bodies.push("main " + String(lib.named)); }, [[0, "named"], [1, "missing"]]),
    "/dep.mjs": esm([], function* (api) { api.l({}); yield; yield; bodies.push("dep"); }),
  };
  const { records, ran } = host(modules, { "/lib.cjs": () => exports });
  const error = await records.importKey("/main.mjs").catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(SyntaxError);
  expect(reads).toEqual([]);
  expect(bodies).toEqual([]);
  expect(ran).toEqual(["/lib.cjs"]);
  // The dependency gains the export (a native build would refetch it); the retry links,
  // runs each body once, and the CommonJS module is not run again.
  modules["/dep.mjs"] = esm([], function* (api) { const missing = 2; api.l({ missing: () => missing }); yield; yield; bodies.push("dep"); }, [], [["missing", "missing"]]);
  const retried = host(modules, { "/lib.cjs": () => exports });
  retried.cache.set("/lib.cjs", exports);
  await retried.records.importKey("/main.mjs");
  expect(bodies).toEqual(["dep", "main 1"]);
  expect(retried.ran).toEqual([]);
});

test("a CommonJS module required before its import is one module, read when the import evaluates", async () => {
  const exports = { count: 1 };
  const { records, ran, cache } = host({
    "/main.mjs": esm(["/lib.cjs"], function* (api) { api.l({}); yield; const lib = api.n[0]!; yield; (globalThis as Record<string, unknown>).seenCount = lib.count; }, [[0, "count"]]),
  }, { "/lib.cjs": () => exports });
  cache.set("/lib.cjs", exports);
  exports.count = 2;
  await records.importKey("/main.mjs");
  expect(ran).toEqual([]);
  expect((globalThis as Record<string, unknown>).seenCount).toBe(2);
});

// Prototype and promise mutations made after the loader exists, as user code could, reach
// neither this layer nor the loader (the source review's host-layer probes). In a process of
// its own: the mutations would break this test runner.
test("built-ins changed after createModuleRecords do not reach the host layer", () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/module-records-hardening.ts")], { encoding: "utf8", timeout: 10_000 });
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe("Module 1,2\n");
  expect(run.status).toBe(0);
});

test("an exited host makes no native call for a new import", async () => {
  const { records, natives } = host({ "/main.mjs": esm([], function* (api) { api.l({}); yield; yield; }) }, {}, () => false);
  expect(await pending(records.importKey("/main.mjs"))).toBe("pending");
  expect(natives).toEqual([]);
});

test("an exit while a CommonJS module loads starts no module body and publishes nothing", async () => {
  let running = true;
  const bodies: string[] = [];
  const { records, natives } = host({
    "/main.mjs": esm(["/exit.cjs", "/later.mjs"], function* (api) { api.l({}); yield; yield; bodies.push("main"); }),
    "/later.mjs": esm([], function* (api) { api.l({}); yield; yield; bodies.push("later"); }),
  }, { "/exit.cjs": () => { running = false; return {}; } }, () => running);
  expect(await pending(records.importKey("/main.mjs"))).toBe("pending");
  expect(bodies).toEqual([]);
  // The graph's records are readied before any CommonJS runs; nothing native follows the exit.
  expect(natives.at(-1)).toBe("handoff /exit.cjs");
  expect(natives.filter(call => call.startsWith("handoff"))).toEqual(["handoff /exit.cjs"]);
});

test("CommonJS namespaces keep the wrapper's keys, defaults and exact namespace shape", async () => {
  const value = { __esModule: true, ok: 1, "a-b": 2, default: "ignored" };
  const { records } = host({}, { "/lib.cjs": () => value });
  const namespace = await records.importKey("/lib.cjs") as Record<string, unknown>;
  expect(Reflect.ownKeys(namespace)).toEqual(["default", "ok", Symbol.toStringTag]);
  expect(namespace.default).toBe(value);
  expect(Object.getOwnPropertyDescriptor(namespace, "ok")).toEqual({ value: 1, writable: true, enumerable: true, configurable: false });
  for (const primitive of [0, "", null, undefined]) {
    const loaded = await host({}, { "/p.cjs": () => primitive }).records.importKey("/p.cjs") as Record<string, unknown>;
    expect(Object.keys(loaded)).toEqual(["default"]);
    expect(loaded.default).toBe(primitive);
  }
});

test("dynamic imports share module records, and an exited host starts nothing new", async () => {
  let running = true;
  const { records, ran } = host({}, { "/lib.cjs": () => ({ n: 1 }) }, () => running);
  const first = await records.importFrom("/lib.cjs", "/main.cjs");
  expect(await records.importKey("/lib.cjs")).toBe(first);
  running = false;
  const late = await Promise.race([records.importFrom("/other.cjs", "/main.cjs").then(() => "settled", () => "rejected"), new Promise(resolve => setTimeout(() => resolve("pending"), 20))]);
  expect(late).toBe("pending");
  expect(ran).toEqual(["/lib.cjs"]);
});
