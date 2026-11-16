import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createContext, runInContext } from "node:vm";

const root = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

type Origin = Readonly<{ test: object | null; invocation: object | null; file: object | null }>;

interface API {
  expect(value: unknown): { toMatchSnapshot(): unknown };
  test: ((name: string, fn?: (done: (error?: unknown) => void) => unknown, options?: number | { retry?: number; repeats?: number; timeout?: number }) => void) & {
    failing(name: string, fn?: (done: (error?: unknown) => void) => unknown, options?: number | { timeout?: number }): void;
  };
  describe: {
    (name: string | (() => void), fn?: () => void): void;
    skip(name: string, fn?: () => void): void;
    todo(name: string, fn?: () => void): void;
  };
  beforeAll(fn: () => unknown): void;
  beforeEach(fn: () => unknown): void;
  afterEach(fn: () => unknown): void;
  afterAll(fn: () => unknown): void;
  onTestFinished(fn: () => unknown): void;
  jest: { setTimeout(ms: number): void };
}

async function runner(load: (api: API, file: string, uncaught: (error: unknown) => void, origin: () => Origin) => unknown, files = ["/control.test.ts"], preloads: string[] = [], args: readonly string[] = [], onWrite?: (name: string, origin: Origin) => void) {
  const imported = new Set<string>();
  const written = new Map<string, string>();
  const process = Object.assign(new EventEmitter(), { env: { AGENT: "0" }, exitCode: 0 });
  const context = createContext({ process, setTimeout, clearTimeout, Blob, Headers, FormData, URLSearchParams,
    Bun: { version: "test", revision: "test" } });
  const factory = (name: string) => {
    let source = readFileSync(new URL(name, root), "utf8");
    if (name === "bun_test.js") source = source.replace("return { exports, run };", "return { exports, run, getExpectationOrigin };");
    return runInContext(`(function () {${transpiler.transformSync(`return (${source})`)}\n})()`, context);
  };
  let stderr = "";
  const modules: Record<string, unknown> = {
    path,
    node_fs: { fs: { existsSync: (name: string) => written.has(name), readFileSync: (name: string) => written.get(name), mkdirSync() {},
      writeFileSync(name: string, contents: string) { written.set(name, contents); onWrite?.(name, runtime.getExpectationOrigin()); } } },
    inspect: { bunInspect: Bun.inspect },
    util: { bunDeepEquals: isDeepStrictEqual },
    test_matchers: factory("test_matchers.ts")({ isPromise: types.isPromise, promiseState: Bun.peek.status, realTimers: { setTimeout },
      promiseThen: (promise: Promise<unknown>, resolve: (value: unknown) => unknown, reject: (value: unknown) => unknown) => promise.then(resolve, reject) }),
  };
  const internal = {
    native: { now: () => performance.now(), cwd: () => "/", stat: () => ({ mode: 0o100644 }),
      writeStdout() {}, writeStderr: (value: string) => { stderr += value; } },
    require: (name: string) => modules[name],
    realTimers: { setTimeout, clearTimeout },
    fakeTimers: { api: {} },
    promiseState: Bun.peek.status,
    isPromise: types.isPromise,
    importModule: async (file: string) => {
      if (imported.has(file)) return;
      imported.add(file);
      await load(runtime.exports, file, error => process.emit("uncaughtException", error), runtime.getExpectationOrigin);
    },
  };
  modules.test_extensions = factory("test_extensions.ts")(internal);
  modules.test_lifecycle = factory("test_lifecycle.ts")();
  const runtime = factory("bun_test.js")(internal);
  await runtime.run(preloads.flatMap(file => ["--preload", file]).concat(args, files));
  return { stderr, exit: process.exitCode, api: runtime.exports, origin: runtime.getExpectationOrigin, written };
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

function expectCounts(result: { stderr: string; exit: number }, passes: number, failures: number) {
  expect(result.exit).toBe(failures ? 1 : 0);
  expect(result.stderr).toContain(` ${passes} pass\n`);
  expect(result.stderr).toContain(` ${failures} fail\n`);
}

test("expected-failure bodies cannot turn timeouts into passes", async () => {
  const result = await runner(api => {
    api.test.failing("promise timeout", never, 5);
    api.test.failing("done timeout", _done => {}, 5);
    api.test.failing("async done timeout", async _done => {}, 5);
  });
  expectCounts(result, 0, 3);
  expect(result.stderr).toContain("timed out after 5ms");
});

test("synchronous and asynchronous errors after successful done fail their own tests", async () => {
  const result = await runner(api => {
    api.test("sync after done", done => { done(); throw new Error("sync after done error"); });
    api.test("async after done", async done => { await Promise.resolve(); done(); throw new Error("async after done error"); });
  });
  expectCounts(result, 0, 2);
  expect(result.stderr).toContain("sync after done error");
  expect(result.stderr).toContain("async after done error");
});

test("successful done waits for a pending returned promise before cleanup", async () => {
  let completed = false;
  const result = await runner(api => {
    api.afterEach(() => expect(completed).toBe(true));
    api.test("done before promise", done => {
      done();
      return markCompleted(() => { completed = true; });
    });
  });
  expectCounts(result, 1, 0);
});

test("successful done cannot hide an indefinitely pending returned promise", async () => {
  const result = await runner(api => {
    api.test("pending promise after done", done => { done(); return never(); }, 5);
  });
  expectCounts(result, 0, 1);
  expect(result.stderr).toContain("timed out after 5ms");
});

test("done errors fail even when the returned promise never settles", async () => {
  const result = await runner(api => {
    api.test("done error", done => { done(new Error("callback error")); return never(); }, 5);
  });
  expectCounts(result, 0, 1);
  expect(result.stderr).toContain("callback error");
  expect(result.stderr).not.toContain("timed out");
});

test("only the first done call contributes its result", async () => {
  const result = await runner(api => {
    api.test("double done", done => { done(); done(new Error("ignored second callback")); });
  });
  expectCounts(result, 1, 0);
  expect(result.stderr).not.toContain("ignored second callback");
});

test("an exception in the callback that calls done belongs to that invocation", async () => {
  const result = await runner((api, _file, uncaught) => registerTimerError(api, uncaught));
  expectCounts(result, 1, 1);
  expect(result.stderr).toContain("(fail) timer error");
  expect(result.stderr).not.toContain("Unhandled error between tests");
});

function registerPreloadControl(api: API, file: string, order: string[]) {
  if (file === "/preload.ts") {
    api.beforeAll(() => { order.push("global before"); });
    api.afterAll(() => { order.push("global after"); });
    api.beforeEach(() => { order.push("before each"); });
    api.afterEach(() => { order.push("after each"); });
    return;
  }
  api.test(file, () => { order.push(file); });
}

test("cached preload hooks span files with one global setup and teardown", async () => {
  const order: string[] = [];
  const result = await runner((api, file) => registerPreloadControl(api, file, order), ["/a.test.ts", "/b.test.ts"], ["/preload.ts"]);
  expectCounts(result, 2, 0);
  expect(order).toEqual(["global before", "before each", "/a.test.ts", "after each", "before each", "/b.test.ts", "after each", "global after"]);
});

test("preload rejects test and describe registration while retaining hooks", async () => {
  const state = { ran: false };
  const result = await runner((api, file) => registerPreloadGuards(api, file, state), ["/a.test.ts"], ["/preload.ts"]);
  expectCounts(result, 1, 0);
});

test("registration outside the runner identifies the API that was called", async () => {
  const { api } = await runner(api => api.test("sentinel", () => {}));
  expect(() => api.test("outside", () => {})).toThrow('Cannot use test outside of the test runner. Run "bun test" to run tests.');
  expect(() => api.describe("outside", () => {})).toThrow('Cannot use describe outside of the test runner. Run "bun test" to run tests.');
  expect(() => api.beforeAll(() => {})).toThrow('Cannot use beforeAll() outside of the test runner. Run "bun test" to run tests.');
});

test("a returned promise does not replace a missing done in the bounded runner", async () => {
  const result = await runner(api => {
    api.test("fulfilled promise", async _done => {}, 5);
  });
  expectCounts(result, 0, 1);
  expect(result.stderr).toContain("timed out after 5ms");
});

test("pending callback promises and done both complete before cleanup", async () => {
  const order: string[] = [];
  const result = await runner(api => registerDoneOrdering(api, order));
  expectCounts(result, 1, 0);
});

function never(): Promise<never> {
  return new Promise(() => {});
}

function markCompleted(mark: () => void): Promise<void> {
  return new Promise(resolve => setTimeout(() => { mark(); resolve(); }, 5));
}

function registerTimerError(api: API, uncaught: (error: unknown) => void) {
  api.test("timer error", done => { setTimeout(() => { done(); uncaught(new Error("timer after done")); }, 0); });
  api.test("following sentinel", () => {});
}

function registerPreloadGuards(api: API, file: string, state: { ran: boolean }) {
  if (file !== "/preload.ts") return api.test("sentinel", () => expect(state.ran).toBe(true));
  api.beforeAll(() => { state.ran = true; });
  expect(() => api.test("forbidden", () => {})).toThrow("Cannot use test during preload.");
  expect(() => api.describe("forbidden", () => {})).toThrow("Cannot use describe during preload.");
}

function recordPromise(order: string[]): Promise<void> {
  return new Promise(resolve => setTimeout(() => { order.push("promise"); resolve(); }, 0));
}

function registerDoneOrdering(api: API, order: string[]) {
  api.afterEach(() => expect(order).toEqual(["promise", "done"]));
  api.test("pending promise before done", done => {
    setTimeout(() => { order.push("done"); done(); }, 10);
    return recordPromise(order);
  });
}

function strictHook(label: string, events: string[], origin?: () => Origin, tokens?: Map<string, object | null>) {
  return function (this: unknown) {
    expect(this).toBeUndefined();
    events.push(label);
    if (origin && tokens) tokens.set(label, origin().file);
  };
}

function orderedPreloads(api: API, file: string, events: string[], origin: () => Origin, tokens: Map<string, object | null>) {
  events.push(`import ${file}`);
  tokens.set(`import ${file}`, origin().file);
  if (file.startsWith("/setup")) {
    api.beforeAll(strictHook(`global before ${file}`, events, origin, tokens));
    api.afterAll(strictHook(`global after ${file}`, events, origin, tokens));
    api.beforeEach(strictHook(`global each before ${file}`, events));
    api.afterEach(strictHook(`global each after ${file}`, events));
    return;
  }
  api.beforeAll(strictHook(`file before ${file}`, events));
  api.afterAll(strictHook(`file after ${file}`, events));
  api.beforeEach(strictHook(`file each before ${file}`, events));
  api.afterEach(strictHook(`file each after ${file}`, events));
  api.describe("nested", () => {
    api.beforeEach(strictHook(`nested before ${file}`, events));
    api.afterEach(strictHook(`nested after ${file}`, events));
    api.test(file, strictHook(`body ${file}`, events, origin, tokens));
  });
}

function fileEvents(file: string) {
  return [
    `file before ${file}`, "global each before /setup-a.ts", "global each before /setup-b.ts",
    `file each before ${file}`, `nested before ${file}`, `body ${file}`, `nested after ${file}`,
    `file each after ${file}`, "global each after /setup-a.ts", "global each after /setup-b.ts", `file after ${file}`,
  ];
}

test("two preloads inherit serial hooks without sharing file tokens or hook receivers", async () => {
  const events: string[] = [];
  const tokens = new Map<string, object | null>();
  const result = await runner((api, file, _uncaught, origin) => orderedPreloads(api, file, events, origin, tokens),
    ["/a.test.ts", "/b.test.ts"], ["/setup-a.ts", "/setup-b.ts"]);
  expectCounts(result, 2, 0);
  expect(events).toEqual(["import /setup-a.ts", "import /setup-b.ts", "import /a.test.ts", "global before /setup-a.ts", "global before /setup-b.ts"]
    .concat(fileEvents("/a.test.ts"), ["import /b.test.ts"], fileEvents("/b.test.ts"), ["global after /setup-a.ts", "global after /setup-b.ts"]));
  expect(tokens.get("import /setup-a.ts")).toBe(tokens.get("import /a.test.ts"));
  expect(tokens.get("body /b.test.ts")).toBe(tokens.get("global after /setup-a.ts"));
  expect(tokens.get("body /a.test.ts")).not.toBe(tokens.get("body /b.test.ts"));
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
});

function callRegistration(register: unknown, args: readonly unknown[]) {
  if (typeof register !== "function") throw new Error("Missing registration method");
  return Reflect.apply(register, undefined, args);
}

function selectionControl(api: API, file: string, events: string[], mode: string) {
  events.push(`import ${file}`);
  if (file === "/setup.ts") {
    api.beforeAll(strictHook("before", events));
    api.afterAll(strictHook("after", events));
    return;
  }
  if (mode === "empty") return;
  const name = file === "/a.test.ts" ? "a" : "b";
  const register = mode === "skip" || mode === "todo" ? Reflect.get(api.test, mode) : api.test;
  callRegistration(register, [name, strictHook(`body ${name}`, events)]);
}

test("global preload hooks run once even when selection leaves no runnable test", async () => {
  const cases = [
    { mode: "normal", args: ["-t", "b"], bodies: ["body b"] },
    { mode: "normal", args: ["-t", "missing"], bodies: [] },
    { mode: "normal", args: ["--only"], bodies: [] },
    { mode: "skip", args: [], bodies: [] },
    { mode: "empty", args: [], bodies: [] },
    { mode: "todo", args: ["--todo"], bodies: ["body a", "body b"] },
  ];
  for (const item of cases) await checkSelection(item);
});

async function checkSelection(item: { mode: string; args: string[]; bodies: string[] }) {
  const events: string[] = [];
  const result = await runner((api, file) => selectionControl(api, file, events, item.mode), ["/a.test.ts", "/b.test.ts"], ["/setup.ts"], item.args);
  expect(events.filter(event => event === "before" || event === "after")).toEqual(["before", "after"]);
  expect(events.filter(event => event.startsWith("body"))).toEqual(item.bodies);
  expect(events.indexOf("before")).toBe(events.indexOf("import /a.test.ts") + 1);
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
}

function importFailureControl(api: API, file: string, events: string[], bad: string, hookFailure: boolean) {
  events.push(`import ${file}`);
  if (file === "/setup.ts") {
    api.beforeAll(strictHook("before", events));
    api.afterAll(strictHook("after", events));
    return;
  }
  if (file === bad && !hookFailure) throw new Error("ordinary import failed");
  if (file === bad) api.beforeAll(() => { throw new Error("local before failed"); });
  api.test(file, strictHook(`body ${file}`, events));
}

test("ordinary import and final local setup failures still finalize global preload hooks", async () => {
  for (const [bad, hookFailure] of [["/a.test.ts", false], ["/b.test.ts", false], ["/b.test.ts", true]] as const) {
    await checkImportFailure(bad, hookFailure);
  }
});

async function checkImportFailure(bad: string, hookFailure: boolean) {
  const events: string[] = [];
  const result = await runner((api, file) => importFailureControl(api, file, events, bad, hookFailure), ["/a.test.ts", "/b.test.ts"], ["/setup.ts"]);
  expectCounts(result, 1, 1);
  expect(events.filter(event => event === "before" || event === "after")).toEqual(["before", "after"]);
  expect(events.at(-1)).toBe("after");
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
}

async function partialPreloadControl(api: API, file: string, events: string[]) {
  events.push(`import ${file}`);
  if (file !== "/setup.ts") return api.test("must not run", strictHook("body", events));
  api.beforeAll(strictHook("must not set up", events));
  api.afterAll(strictHook("must not tear down", events));
  await Promise.resolve();
  expect(() => api.test("still forbidden", () => {})).toThrow("Cannot use test during preload.");
  throw new Error("awaited preload import failed");
}

test("a rejected partial preload stops import and hooks without replaying declarations", async () => {
  const events: string[] = [];
  const result = await runner((api, file) => partialPreloadControl(api, file, events), ["/a.test.ts", "/b.test.ts"], ["/setup.ts"]);
  expectCounts(result, 0, 1);
  expect(events).toEqual(["import /setup.ts"]);
  expect(result.stderr.match(/error: awaited preload import failed/g)?.length).toBe(1);
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
  expect(() => result.api.test("closed", () => {})).toThrow("outside of the test runner");
});

function stoppedSetupControl(api: API, file: string, events: string[]) {
  events.push(`import ${file}`);
  if (file !== "/setup.ts") return api.test(file, strictHook("must not run", events));
  api.beforeAll(strictHook("first setup hook", events));
  api.beforeAll(async () => { await Promise.resolve(); events.push("failed setup"); throw new Error("global setup failed"); });
  api.beforeAll(strictHook("must not set up again", events));
  api.afterAll(strictHook("after", events));
}

test("failed global setup stays stopped while consuming global teardown once", async () => {
  const events: string[] = [];
  const result = await runner((api, file) => stoppedSetupControl(api, file, events), ["/a.test.ts", "/b.test.ts"], ["/setup.ts"]);
  expectCounts(result, 0, 1);
  expect(events).toEqual(["import /setup.ts", "import /a.test.ts", "first setup hook", "failed setup", "import /b.test.ts", "after"]);
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
});

function flushAfterFailureControl(api: API, file: string, events: string[], origin: () => Origin, tokens: Map<string, object | null>) {
  if (file === "/setup.ts") {
    api.afterAll(() => { events.push("after"); tokens.set("after", origin().file); throw new Error("global teardown failed"); });
    api.afterAll(strictHook("must not tear down again", events));
    return;
  }
  api.test(file, () => {
    tokens.set(file, origin().file);
    if (file === "/b.test.ts") api.expect("queued final snapshot").toMatchSnapshot();
  });
}

test("global teardown rejection preserves final-file snapshot flush and file identity", async () => {
  const events: string[] = [];
  const tokens = new Map<string, object | null>();
  const result = await runner((api, file, _uncaught, origin) => flushAfterFailureControl(api, file, events, origin, tokens),
    ["/a.test.ts", "/b.test.ts"], ["/setup.ts"], [], (name, origin) => { events.push(`flush ${name}`); tokens.set("flush", origin.file); });
  expectCounts(result, 2, 1);
  expect(events).toEqual(["after", "flush /__snapshots__/b.test.ts.snap"]);
  expect(result.written.get("/__snapshots__/b.test.ts.snap")).toContain("queued final snapshot");
  expect(tokens.get("after")).toBe(tokens.get("/b.test.ts"));
  expect(tokens.get("flush")).toBe(tokens.get("/b.test.ts"));
  expect(tokens.get("/a.test.ts")).not.toBe(tokens.get("/b.test.ts"));
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
});

test("snapshot write failures restore file identity after global teardown", async () => {
  const events: string[] = [];
  const tokens = new Map<string, object | null>();
  const result = await runner((api, file, _uncaught, origin) => flushAfterFailureControl(api, file, events, origin, tokens),
    ["/a.test.ts", "/b.test.ts"], ["/setup.ts"], [], () => { throw new Error("snapshot write failed"); });
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("snapshot write failed");
  expect(events).toEqual(["after"]);
  expect(result.origin()).toEqual({ test: null, invocation: null, file: null });
});

function rejectedPreloadRegistrations(api: API, file: string, state: { reads: number; callbacks: number }) {
  if (file !== "/setup.ts") return api.test("ordinary sentinel", () => {});
  const callback = () => { state.callbacks++; };
  const options = { get timeout() { state.reads++; return 1; } };
  for (const name of ["skip", "todo", "only", "failing", "concurrent", "serial"]) checkRejected(Reflect.get(api.test, name), ["bad", callback, options], "test");
  for (const name of ["skip", "todo", "only", "concurrent", "serial"]) checkRejected(Reflect.get(api.describe, name), ["bad", callback], "describe");
  checkRejected(api.test, [], "test");
  checkRejected(api.test, ["bad", callback, options], "test");
  checkRejected(api.describe, [callback], "describe");
  for (const [register, kind] of [[api.test, "test"], [api.describe, "describe"]] as const) checkRejectedEach(register, kind, callback);
}

function checkRejected(register: unknown, args: readonly unknown[], kind: string) {
  expect(() => callRegistration(register, args)).toThrow(`Cannot use ${kind} during preload.`);
}

function checkRejectedEach(register: object, kind: string, callback: () => void) {
  for (const rows of [[], [1]]) {
    const each = callRegistration(Reflect.get(register, "each"), [rows]);
    checkRejected(each, ["bad", callback], kind);
  }
}

test("every preload registration rejects before validation or empty-table expansion", async () => {
  const state = { reads: 0, callbacks: 0 };
  const result = await runner((api, file) => rejectedPreloadRegistrations(api, file, state), ["/a.test.ts"], ["/setup.ts"]);
  expectCounts(result, 1, 0);
  expect(state).toEqual({ reads: 0, callbacks: 0 });
});

test("a completed done body does not wait for a timer checkpoint", async () => {
  const result = await runner(api => { api.test("fulfilled done", async done => { done(); }, 1); });
  expectCounts(result, 1, 0);
});
