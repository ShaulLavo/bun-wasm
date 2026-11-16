import { expect, test } from "bun:test";
import { runner, type API } from "./test-runner-source.ts";

function registerCallable(api: API, order: string[]) {
  api.describe(() => { api.test("sole", () => order.push("sole")); });
  const anonymous = () => {};
  expect(() => api.describe(anonymous, anonymous)).not.toThrow();
  expect(() => Reflect.apply(api.describe, undefined, [() => {}, () => {}])).toThrow("describe() expects first argument");
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

test("callable describe executes and anonymous labels reject two arguments", async () => {
  const order: string[] = [];
  const result = await runner(api => registerCallable(api, order));
  expect(order).toEqual(["sole"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("1 pass");
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
