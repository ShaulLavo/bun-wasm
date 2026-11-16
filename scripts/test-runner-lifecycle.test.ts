import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createContext, runInContext } from "node:vm";

const root = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface API {
  test: ((name: string, fn?: () => unknown, options?: { retry?: number; repeats?: number; timeout?: number }) => void) & {
    failing(name: string, fn?: () => unknown): void;
  };
  describe: {
    (name: string | (() => void), fn?: () => void): void;
    skip(name: string, fn?: () => void): void;
    todo(name: string, fn?: () => void): void;
  };
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
    test_matchers: factory("test_matchers.ts")({ isPromise: types.isPromise, realTimers: { setTimeout },
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

function registerValidation(api: API) {
  expect(() => api.test.failing("missing")).toThrow("test.failing expects a function as the second argument");
  expect(api.jest.setTimeout(5000)).toBeUndefined();
  let invalid: unknown;
  try { Reflect.apply(api.onTestFinished, undefined, [1]); } catch (error) { invalid = error; }
  expect(invalid).toMatchObject({ name: "Error", message: "onTestFinished() expects a function as the first argument" });
  api.test("registered", () => {
    expect(() => api.test.failing("missing")).toThrow("test.failing expects a function as the second argument");
  });
}

function registerRetry(api: API, order: string[], state: { retries: number }) {
  api.beforeEach(() => { order.push("before"); });
  api.afterEach(() => { order.push("after"); });
  api.test("retry", () => {
    state.retries++;
    api.onTestFinished(() => { order.push("finished"); });
    api.afterAll(() => { order.push("inner"); });
    order.push("test");
    if (state.retries < 3) throw new Error("intentional retry");
  }, { retry: 3 });
  api.test("repeat", () => { order.push("repeat"); }, { repeats: 2 });
  expect(() => api.test("both", () => {}, { retry: 1, repeats: 1 })).toThrow("Cannot set both retry and repeats");
}

function registerDoubleFailure(api: API, order: string[]) {
  api.afterEach(() => { order.push("must not run"); });
  api.test("both fail", () => {
    api.afterAll(() => { order.push("must not run"); });
    api.afterAll(() => { order.push("cleanup"); throw new Error("cleanup also failed"); });
    api.onTestFinished(() => { order.push("must not run"); });
    throw new Error("body failed first");
  });
}

function registerFailingCleanup(api: API, phase: string, bodyFails: boolean) {
  api.test.failing("cleanup status", () => {
    const cleanup = async () => { throw new Error("cleanup rejection"); };
    if (phase === "local") api.afterAll(cleanup);
    else api.onTestFinished(cleanup);
    if (bodyFails) throw new Error("expected body");
  });
}

function registerOptionValidation(api: API) {
  for (const repeats of [null, "bad", false]) {
    const options = { retry: 1, repeats };
    expect(() => Reflect.apply(api.test, undefined, ["invalid", () => {}, options])).toThrow("expects repeats to be a number");
    expect(() => Reflect.apply(Reflect.get(api.test, "skip"), undefined, ["invalid", () => {}, options])).toThrow("expects repeats to be a number");
  }
  expect(() => api.test("conflict", () => {}, { retry: 1, repeats: 0 })).toThrow("Cannot set both retry and repeats");
  api.test("sentinel", () => {});
}

function registerTimeoutOrder(api: API, order: string[], state: { bodies: number }) {
  let repeats = 1;
  api.test("runs once", () => { state.bodies++; }, {
    get timeout() { order.push("timeout"); repeats = 0; return 1000; },
    get retry() { order.push("retry"); return 0; },
    get repeats() { order.push("repeats"); return repeats; },
  });
}

function registerThrowingTimeout(api: API) {
  const body = () => {};
  for (const method of [api.test, Reflect.get(api.test, "skip")]) {
    const marker = new Error("timeout getter");
    const reads: string[] = [];
    const options = {
      get timeout() { reads.push("timeout"); throw marker; },
      get retry() { reads.push("retry"); return "bad"; },
      get repeats() { reads.push("repeats"); return "bad"; },
    };
    let error: unknown;
    try { Reflect.apply(method, undefined, ["must not register", body, options]); } catch (value) { error = value; }
    expect(error).toBe(marker);
    expect(reads).toEqual(["timeout"]);
  }
  api.test("sentinel", () => {});
}

test("timeout is read once before repeat policy can change execution count", async () => {
  const order: string[] = [];
  const state = { bodies: 0 };
  const result = await runner(api => registerTimeoutOrder(api, order, state));
  expect(result.exit).toBe(0);
  expect(state.bodies).toBe(1);
  expect(order).toEqual(["timeout", "retry", "repeats"]);
});

test("timeout getter errors precede retry and repeats validation", async () => {
  const result = await runner(registerThrowingTimeout);
  expect(result.exit).toBe(0);
});

test("failing tests do not absorb cleanup failure after a successful body", async () => {
  for (const phase of ["local", "finished"]) {
    const result = await runner(api => registerFailingCleanup(api, phase, false));
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("0 pass");
    expect(result.stderr).toContain("1 fail");
    expect(result.stderr.match(/error: cleanup rejection/g)?.length).toBe(1);
  }
});

test("failing bodies still pass while cleanup rejection stays visible", async () => {
  for (const phase of ["local", "finished"]) {
    const result = await runner(api => registerFailingCleanup(api, phase, true));
    expect(result.exit).toBe(0);
    expect(result.stderr).toContain("1 pass");
    expect(result.stderr).toContain("0 fail");
    expect(result.stderr.match(/error: cleanup rejection/g)?.length).toBe(1);
    expect(result.stderr).not.toContain("expected body");
  }
});

test("repeats type validation precedes retry conflict even for skipped tests", async () => {
  const result = await runner(registerOptionValidation);
  expect(result.exit).toBe(0);
});

test("failing registration requires its callback and jest timeout keeps native return", async () => {
  const result = await runner(registerValidation);
  expect(result.exit).toBe(0);
});

test("retry and repeats rerun hooks and report only the final outcome", async () => {
  const order: string[] = [];
  const result = await runner(api => registerRetry(api, order, { retries: 0 }));
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
  const result = await runner(api => registerDoubleFailure(api, order));
  expect(order).toEqual(["cleanup"]);
  expect(result.stderr).toContain("body failed first");
  expect(result.stderr).toContain("cleanup also failed");
  expect(result.stderr).toContain("1 fail");
  expect(result.exit).toBe(1);
});

function appendLocalCleanup(api: API, order: string[]) {
  order.push("local");
  api.afterAll(() => { order.push("local-reentry"); });
  api.onTestFinished(() => { order.push("local-finished"); });
}

function appendFinishedCleanup(api: API, order: string[]) {
  order.push("finished");
  api.onTestFinished(() => { order.push("finished-reentry"); });
}

function registerLiveCleanup(api: API, order: string[]) {
  api.afterEach(() => { order.push("after"); api.onTestFinished(() => { order.push("after-finished"); }); });
  api.test("live cleanup", () => {
    api.afterAll(() => appendLocalCleanup(api, order));
    api.onTestFinished(() => appendFinishedCleanup(api, order));
  });
}

test("cleanup drains newly registered local and finished callbacks in phase order", async () => {
  const order: string[] = [];
  const result = await runner(api => registerLiveCleanup(api, order));
  expect(result.exit).toBe(0);
  expect(order).toEqual(["local", "local-reentry", "after", "finished", "local-finished", "after-finished", "finished-reentry"]);
});

function registerCleanupRejection(api: API, order: string[]) {
  api.afterEach(() => {
    api.onTestFinished(async () => { throw new Error("late cleanup rejection"); });
    api.onTestFinished(() => { order.push("must not run"); });
  });
  api.test("cleanup failure", () => {});
}

test("reentrant cleanup rejection fails the test and stops following callbacks", async () => {
  const order: string[] = [];
  const result = await runner(api => registerCleanupRejection(api, order));
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("late cleanup rejection");
  expect(result.stderr).toContain("1 fail");
  expect(order).toEqual([]);
});

test("callback-free skipped and todo describe preserve following registration", async () => {
  const result = await runner(api => {
    api.describe.skip("pending suite");
    api.describe.todo("todo suite");
    api.test("sentinel", () => {});
  });
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("1 pass");
});
