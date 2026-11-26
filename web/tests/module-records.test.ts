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
function host(modules: Record<string, ModuleRecord>, cjs: Record<string, () => unknown>, active = () => true, overrides: Partial<RecordHost> = {}) {
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
    generation: () => 0,
    active,
    track: operation => operation,
    ...overrides,
  };
  return { records: createModuleRecords(recordHost, factory, then), ran, natives, cache };
}

/**
 * A changeable file tree for `host`: `./name` resolves against the importer's directory
 * through `files` (path -> module key), and a missing path throws like the runtime. `bump`
 * stands for a path change made through this process's natives (`resolverGeneration`).
 */
function tree(entries: Record<string, string>) {
  const files = new Map(Object.entries(entries));
  const resolved: string[] = [];
  let generation = 0;
  const resolve = (specifier: string, referrer: string) => {
    resolved.push(`${specifier} from ${referrer}`);
    const path = specifier.startsWith("./") ? referrer.slice(0, referrer.lastIndexOf("/") + 1) + specifier.slice(2) : specifier;
    const key = files.get(path);
    if (key === undefined) throw new Error(`Cannot find module '${specifier}' from '${referrer}'`);
    return key;
  };
  return { files, resolved, overrides: { resolve, generation: () => generation }, bump: () => { generation += 1; } };
}

/** A record exporting `value`. */
const valued = (value: string, requests: string[] = []) => esm(requests, function* (api) { api.l({ value: () => value }); yield; yield; }, [], [["value", "value"]]);
const empty = (requests: string[] = []) => esm(requests, function* (api) { api.l({}); yield; yield; });

async function until(condition: () => boolean) {
  for (let turn = 0; turn < 1000 && !condition(); turn++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
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

/** A module whose body records the `value` export of its one request. */
const reader = (seen: string[], name: string) => esm(["./dep.mjs"], function* (api) { api.l({}); yield; const dep = api.n[0]!; yield; seen.push(`${name} ${String(dep.value)}`); }, [[0, "value"]]);

test("a graph resolves each specifier once per importer directory, and its link reuses that", async () => {
  const files = tree({ "/app/main.mjs": "/app/main.mjs", "/app/a.mjs": "/app/a.mjs", "/app/b.mjs": "/app/b.mjs", "/app/shared.mjs": "/app/shared.mjs" });
  const { records } = host({
    "/app/main.mjs": empty(["./a.mjs", "./b.mjs"]),
    "/app/a.mjs": empty(["./shared.mjs"]),
    "/app/b.mjs": empty(["./shared.mjs"]),
    "/app/shared.mjs": empty(),
  }, {}, undefined, files.overrides);
  await records.importKey("/app/main.mjs");
  expect(files.resolved).toEqual(["./a.mjs from /app/main.mjs", "./b.mjs from /app/main.mjs", "./shared.mjs from /app/a.mjs"]);
  // Nothing outlives the preparation: the next one resolves afresh.
  await records.importKey("/app/main.mjs");
  expect(files.resolved.length).toBe(6);
});

test("a path change while the graph is prepared empties its resolutions", async () => {
  const seen: string[] = [];
  const files = tree({ "/main.mjs": "/main.mjs", "/a.mjs": "/a.mjs", "/dep.mjs": "/old.mjs" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const modules: Record<string, ModuleRecord> = {
    "/main.mjs": esm(["./dep.mjs", "./a.mjs"], function* (api) { api.l({}); yield; const dep = api.n[0]!; yield; seen.push(`main ${String(dep.value)}`); }, [[0, "value"]]),
    "/a.mjs": reader(seen, "a"), "/old.mjs": valued("old"), "/new.mjs": valued("new"),
  };
  const { records } = host(modules, {}, undefined, {
    ...files.overrides,
    evaluate: (code, key, done) => { void (key === "/a.mjs" ? gate : Promise.resolve()).then(() => done(modules[code]!)); },
  });
  const imported = records.importKey("/main.mjs");
  await until(() => files.resolved.length === 2);
  // While /a.mjs evaluates, this process renames a file: /a.mjs's own request must see it.
  files.files.set("/dep.mjs", "/new.mjs");
  files.bump();
  release();
  await imported;
  expect(seen).toEqual(["a new", "main new"]);
});

test("a CommonJS module that changes a path during linking leaves later requests to the live resolver", async () => {
  const files = tree({ "/main.mjs": "/main.mjs", "/mutate.cjs": "/mutate.cjs", "/dep.mjs": "/dep.mjs" });
  const bodies: string[] = [];
  const { records } = host({
    "/main.mjs": esm(["./mutate.cjs", "./dep.mjs"], function* (api) { api.l({}); yield; yield; bodies.push("main"); }),
    "/dep.mjs": valued("dep"),
  }, { "/mutate.cjs": () => { files.files.delete("/dep.mjs"); files.bump(); return {}; } }, undefined, files.overrides);
  const error = await records.importKey("/main.mjs").catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Cannot find module './dep.mjs' from '/main.mjs'");
  expect(bodies).toEqual([]);
});

test("import() resolves its specifier live, never from an earlier graph's resolutions", async () => {
  const files = tree({ "/main.mjs": "/main.mjs", "/dep.mjs": "/dep.mjs" });
  const { records } = host({ "/main.mjs": empty(["./dep.mjs"]), "/dep.mjs": valued("original"), "/mock.mjs": valued("replacement") }, {}, undefined, files.overrides);
  await records.importKey("/main.mjs");
  // As mock.module() would: the same specifier now names another module.
  files.files.set("/dep.mjs", "/mock.mjs");
  expect(((await records.importFrom("./dep.mjs", "/main.mjs")) as { value: string }).value).toBe("replacement");
  files.files.delete("/dep.mjs");
  const error = await records.importFrom("./dep.mjs", "/main.mjs").catch((caught: Error) => caught);
  expect((error as Error).message).toBe("Cannot find module './dep.mjs' from '/main.mjs'");
});

test("overlapping preparations each link with their own resolutions", async () => {
  const seen: string[] = [];
  const files = tree({ "/a.mjs": "/a.mjs", "/b.mjs": "/b.mjs", "/shared.mjs": "/shared.mjs", "/dep.mjs": "/old.mjs" });
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  for (const key of ["/old.mjs", "/new.mjs"]) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    gates.set(key, { promise, release });
  }
  const modules: Record<string, ModuleRecord> = {
    "/a.mjs": empty(["./shared.mjs"]), "/b.mjs": empty(["./shared.mjs"]), "/shared.mjs": reader(seen, "shared"),
    "/old.mjs": valued("old"), "/new.mjs": valued("new"),
  };
  const { records, natives } = host(modules, {}, undefined, {
    ...files.overrides,
    evaluate: (code, key, done) => { void (gates.get(key)?.promise ?? Promise.resolve()).then(() => done(modules[code]!)); },
  });
  // A reaches the shared module, finds /old.mjs and waits for its record.
  const a = records.importKey("/a.mjs");
  await until(() => natives.includes("record /old.mjs"));
  // Another writer changes the target; B reaches the same module, finds /new.mjs and waits.
  files.files.set("/dep.mjs", "/new.mjs");
  const b = records.importKey("/b.mjs");
  await until(() => natives.includes("record /new.mjs"));
  files.files.set("/dep.mjs", "/old.mjs");
  gates.get("/old.mjs")!.release();
  await a;
  expect(seen).toEqual(["shared old"]);
  gates.get("/new.mjs")!.release();
  await b;
  expect(natives.filter(call => call.startsWith("handoff"))).toEqual([]);
});
