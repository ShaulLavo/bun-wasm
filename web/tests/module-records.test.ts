import { expect, test } from "bun:test";
import { loaderSource } from "../../scripts/esm-loader-harness.ts";
import { createModuleRecords, type LoaderFactory, type ModuleRecord, type RecordHost } from "../src/module-records.ts";

// The runtime's record loader, as EngineHost gets it from the wasm (`polyfillSource("esm_loader")`).
// oxlint-disable-next-line no-eval -- Evaluates the loader factory like the engine host does.
const factory = (0, eval)(`(${loaderSource()})`) as LoaderFactory;

type Body = (api: { l(getters: Record<string, () => unknown>): void; n: Record<string, unknown>[] }) => Generator<unknown, void, unknown>;
const esm = (requests: string[], f: Body, imports: [number, string][] = []): ModuleRecord => ({ r: requests, i: imports, x: [], s: [], a: false, f: f as ModuleRecord["f"] });

/** A host whose ES modules are hand-written records and whose CommonJS modules are `cjs`. */
function host(modules: Record<string, ModuleRecord>, cjs: Record<string, () => unknown>, active = () => true) {
  const ran: string[] = [];
  const recordHost: RecordHost = {
    record: key => key in modules ? { format: "esm", record: key } : { format: "cjs" },
    evaluate: async code => modules[code]!,
    handoff: key => { ran.push(key); const value = cjs[key]!(); return { value, default: value }; },
    keys: value => value !== null && typeof value === "object"
      ? Object.keys(value).filter(key => key !== "default" && key !== "__esModule" && /^[\p{L}\p{N}_$]+$/u.test(key))
      : [],
    initMeta() {},
    resolve: specifier => specifier,
    active,
    track: operation => operation,
  };
  return { records: createModuleRecords(recordHost, factory), ran };
}

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

test("a link error comes before any CommonJS export getter runs, and the body is not rerun", async () => {
  const reads: string[] = [];
  const exports = { get named() { reads.push("named"); return 1; } };
  const { records, ran } = host({
    "/main.mjs": esm(["/lib.cjs", "/dep.mjs"], function* (api) { api.l({}); yield; yield; }, [[0, "named"], [1, "missing"]]),
    "/dep.mjs": esm([], function* (api) { api.l({}); yield; yield; }),
  }, { "/lib.cjs": () => exports });
  const error = await records.importKey("/main.mjs").catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(SyntaxError);
  expect(reads).toEqual([]);
  expect(ran).toEqual(["/lib.cjs"]);
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
