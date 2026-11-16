import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createContext, runInContext } from "node:vm";

const root = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface API {
  test: ((name: string, fn?: () => unknown, options?: { retry?: number; repeats?: number }) => void) & {
    failing(name: string, fn?: () => unknown): void;
  };
  describe: { (name: string | (() => void), fn?: () => void): void };
  beforeEach(fn: () => unknown): void;
  afterEach(fn: () => unknown): void;
  afterAll(fn: () => unknown): void;
  onTestFinished(fn: () => unknown): void;
  jest: { setTimeout(ms: number): void };
}

async function runner(load: (api: API) => void) {
  const process = Object.assign(new EventEmitter(), { env: { AGENT: "0" }, exitCode: 0 });
  const context = createContext({ process, setTimeout, clearTimeout, Blob, Headers, FormData, URLSearchParams,
    Bun: { version: "test", revision: "test" } });
  const factory = (name: string) => runInContext(`(function () {${transpiler.transformSync(`return (${readFileSync(new URL(name, root), "utf8")})`)}\n})()`, context);
  let stderr = "";
  const modules: Record<string, unknown> = {
    path,
    inspect: { bunInspect: Bun.inspect },
    util: { bunDeepEquals: isDeepStrictEqual },
    test_matchers: factory("test_matchers.ts")({ isPromise: types.isPromise,
      promiseThen: (promise: Promise<unknown>, resolve: (value: unknown) => unknown, reject: (value: unknown) => unknown) => promise.then(resolve, reject) }),
  };
  const internal = {
    native: { now: () => performance.now(), cwd: () => "/", stat: () => ({ mode: 0o100644 }),
      writeStdout() {}, writeStderr: (value: string) => { stderr += value; } },
    require: (name: string) => modules[name],
    realTimers: { setTimeout, clearTimeout },
    fakeTimers: { api: {} },
    importModule: async () => load(runtime.exports),
  };
  modules.test_extensions = factory("test_extensions.ts")(internal);
  modules.test_lifecycle = factory("test_lifecycle.ts")();
  const runtime = factory("bun_test.js")(internal);
  await runtime.run(["/control.test.ts"]);
  return { stderr, exit: process.exitCode };
}

test("callable describe executes and anonymous labels reject two arguments", async () => {
  const order: string[] = [];
  const result = await runner(api => {
    api.describe(() => { api.test("sole", () => order.push("sole")); });
    expect(() => api.describe(() => {}, () => {})).toThrow("describe() expects first argument");
  });
  expect(order).toEqual(["sole"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("1 pass");
});

test("failing registration requires its callback and jest timeout keeps native return", async () => {
  const result = await runner(api => {
    expect(() => api.test.failing("missing")).toThrow("test.failing expects a function as the second argument");
    expect(api.jest.setTimeout(5000)).toBeUndefined();
    api.test("registered", () => {});
  });
  expect(result.exit).toBe(0);
});

test("retry and repeats rerun hooks and report only the final outcome", async () => {
  const order: string[] = [];
  let retries = 0;
  const result = await runner(api => {
    api.beforeEach(() => { order.push("before"); });
    api.afterEach(() => { order.push("after"); });
    api.test("retry", () => {
      retries++;
      api.onTestFinished(() => { order.push("finished"); });
      api.afterAll(() => { order.push("inner"); });
      order.push("test");
      if (retries < 3) throw new Error("intentional retry");
    }, { retry: 3 });
    api.test("repeat", () => { order.push("repeat"); }, { repeats: 2 });
    expect(() => api.test("both", () => {}, { retry: 1, repeats: 1 })).toThrow("Cannot set both retry and repeats");
  });
  expect(order).toEqual(Array.from({ length: 3 }, () => ["before", "test", "inner", "after", "finished"]).flat()
    .concat(Array.from({ length: 3 }, () => ["before", "repeat", "after"]).flat()));
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("2 pass");
  expect(result.stderr).toContain("0 fail");
  expect(result.stderr).toContain("(attempt 3)");
  expect(result.stderr).toContain("(run 3)");
  expect(result.stderr.match(/error: intentional retry/g)?.length).toBe(2);
});

test("repeat stops on failure and retry exhaustion preserves failure", async () => {
  let repeats = 0;
  let retries = 0;
  const result = await runner(api => {
    api.test("repeat fails", () => { repeats++; throw new Error("repeat failure"); }, { repeats: 2 });
    api.test("retry fails", () => { retries++; throw new Error("retry failure"); }, { retry: 2 });
  });
  expect(repeats).toBe(1);
  expect(retries).toBe(3);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("2 fail");
});

test("body and cleanup failures both remain visible and cleanup stops", async () => {
  const order: string[] = [];
  const result = await runner(api => {
    api.afterEach(() => { order.push("must not run"); });
    api.test("both fail", () => {
      api.afterAll(() => { order.push("must not run"); });
      api.afterAll(() => { order.push("cleanup"); throw new Error("cleanup also failed"); });
      api.onTestFinished(() => { order.push("must not run"); });
      throw new Error("body failed first");
    });
  });
  expect(order).toEqual(["cleanup"]);
  expect(result.stderr).toContain("body failed first");
  expect(result.stderr).toContain("cleanup also failed");
  expect(result.stderr).toContain("1 fail");
  expect(result.exit).toBe(1);
});
