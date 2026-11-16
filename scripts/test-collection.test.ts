import { expect, test } from "bun:test";
import { runner, type API } from "./test-runner-source.ts";

const delay = () => new Promise<void>(resolve => setTimeout(resolve, 1));

function registerOrder(api: API, events: string[]) {
  events.push("before");
  const returned = api.describe("A", async () => {
    events.push("A enter"); await delay(); events.push("A resume");
    api.describe("nested", async () => { await delay(); events.push("nested collect"); api.test("nested", () => events.push("nested body")); });
    events.push("after nested call");
    api.test("A", () => events.push("A body"));
  });
  expect(returned).toBeUndefined();
  events.push("after");
  api.describe("B", async () => { events.push("B enter"); await Promise.resolve(); api.test("B", () => events.push("B body")); });
  api.test("sentinel", () => events.push("sentinel"));
}

test("describe returns undefined before serial depth-first collection starts", async () => {
  const events: string[] = [];
  const result = await runner(async api => { registerOrder(api, events); await delay(); events.push("root TLA"); });
  expect(result.exit).toBe(0);
  expect(events).toEqual(["before", "after", "root TLA", "A enter", "A resume", "after nested call", "nested collect", "B enter", "nested body", "A body", "B body", "sentinel"]);
  expect(result.stderr).toContain("4 pass");
  expect(result.stderr).toContain("A > nested > nested");
});

function registerFailure(api: API, events: string[], only: "test" | "describe" | "nested" | "good" | "none") {
  const body = async () => {
    api.beforeAll(() => events.push("must not run"));
    const register = only === "test" ? api.test.only : api.test;
    register("excluded", () => events.push("must not run"));
    const nested = only === "nested" ? api.describe.only : api.describe;
    nested("excluded nested", () => events.push("must not collect"));
    await delay(); throw new Error("owned collection rejection");
  };
  const describe = only === "describe" ? api.describe.only : api.describe;
  describe("bad", body);
  if (only === "good") api.describe.only("good", () => { api.test("selected", () => events.push("good")); });
  api.test("sentinel", () => events.push("sentinel"));
}

for (const only of ["none", "test", "describe", "nested", "good"] as const) {
  test(`rejected collection excludes its subtree and keeps sticky only: ${only}`, async () => {
    const events: string[] = [];
    const result = await runner(api => registerFailure(api, events, only));
    expect(result.exit).toBe(1);
    expect(result.stderr.match(/# Unhandled error between tests/g)).toHaveLength(1);
    expect(result.stderr).toContain("0 fail");
    expect(result.stderr).toContain("1 error");
    expect(events).toEqual(only === "none" ? ["sentinel"] : only === "good" ? ["good"] : []);
  });
}

test("genuine returned Promise rejection ignores an overridden then and never assimilates its reason", async () => {
  let reads = 0;
  const result = await runner(api => {
    api.describe("reject", () => {
      const error = Object.defineProperty(new Error("intrinsic rejection"), "then", { get() { reads++; throw Error("reason then read"); } });
      const completion = Promise.reject(error);
      Object.defineProperty(completion, "then", { get() { reads++; throw Error("public then read"); } });
      return completion;
    });
    api.test("sentinel", () => {});
  });
  expect(reads).toBe(0);
  expect(result.stderr).toContain("intrinsic rejection");
  expect(result.stderr).toContain("1 pass");
  expect(result.stderr).toContain("0 fail");
  expect(result.stderr).toContain("1 error");
  expect(result.exit).toBe(1);
});

test("duplicate callbacks collect twice and disabled callbacks are still collected", async () => {
  const events: string[] = [];
  const result = await runner(api => {
    const callback = async () => { await delay(); api.test("registered", () => events.push("body")); };
    api.describe("one", callback); api.describe("two", callback);
    api.describe.skip("skip", async () => { await delay(); events.push("skip collected"); api.test("disabled", () => events.push("must not run")); });
    api.describe.todo("todo", async () => { await delay(); events.push("todo collected"); api.test("disabled", () => events.push("must not run")); });
  });
  expect(result.exit).toBe(0);
  expect(events).toEqual(["skip collected", "todo collected", "body", "body"]);
  expect(result.stderr).toContain("one > registered");
  expect(result.stderr).toContain("two > registered");
  expect(result.stderr).toContain("2 pass");
});

function attempt(rejected: string[], label: string, register: () => void) {
  try { register(); } catch (error) { rejected.push(label); expect(String(error)).toMatch(/collection|test file/); }
}

function beginLateRegistration(api: API, release: Promise<void>, rejected: string[], complete: () => void) {
  void (async () => {
    await release;
    attempt(rejected, "test", () => api.test.only("stale only", () => {}));
    attempt(rejected, "describe", () => api.describe.only("stale only", () => {}));
    attempt(rejected, "afterAll", () => api.afterAll(() => { throw Error("stale cleanup ran"); }));
    attempt(rejected, "finished", () => api.onTestFinished(() => { throw Error("stale cleanup ran"); }));
    complete();
  })();
}

test("parent callback admission is revoked before collecting its nested scope", async () => {
  const gate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const rejected: string[] = [];
  const result = await runner(api => {
    api.describe("parent", () => {
      beginLateRegistration(api, gate.promise, rejected, completed.resolve);
      api.describe("child", async () => { gate.resolve(); await completed.promise; api.test("child", () => {}); });
    });
    api.test("sentinel", () => {});
  });
  expect(result.exit).toBe(0);
  expect(rejected).toEqual(["test", "describe", "afterAll", "finished"]);
  expect(result.stderr).toContain("2 pass");
});

test("closed file cannot mutate a later test's cleanup queues; unframed execution still can", async () => {
  const gate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const rejected: string[] = [];
  const events: string[] = [];
  const result = await runner((api, file) => {
    if (file === "/A.test.ts") {
      api.describe("origin", () => beginLateRegistration(api, gate.promise, rejected, completed.resolve));
      return;
    }
    api.test("later", async () => {
      gate.resolve(); await completed.promise;
      api.afterAll(() => events.push("ordinary local"));
      api.onTestFinished(() => events.push("ordinary finished"));
    });
  }, ["/A.test.ts", "/B.test.ts"]);
  expect(result.exit).toBe(0);
  expect(rejected).toEqual(["test", "describe", "afterAll", "finished"]);
  expect(events).toEqual(["ordinary local", "ordinary finished"]);
  expect(result.stderr).toContain("1 pass");
});

test("missing collection frame cannot mutate an admitted sibling", async () => {
  const gate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const rejected: string[] = [];
  let api: API;
  const external = gate.promise.then(() => { attempt(rejected, "missing", () => api.test.only("missing", () => {})); completed.resolve(); });
  const result = await runner(current => {
    api = current;
    api.describe("admitted", async () => { gate.resolve(); await completed.promise; api.test("owned", () => {}); });
    api.test("sentinel", () => {});
  });
  await external;
  expect(rejected).toEqual(["missing"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("2 pass");
});

test("root import rejection never invokes queued describes and closes the file", async () => {
  const events: string[] = [];
  const result = await runner(async api => {
    api.describe("queued", () => events.push("must not collect"));
    await delay(); throw Error("root import rejection");
  });
  expect(events).toEqual([]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("1 fail");
  expect(result.stderr).toContain("1 error");
});

test("preload completion and root TLA finish before deferred callbacks", async () => {
  const events: string[] = [];
  const result = await runner(async (api, file) => {
    events.push("import " + file); await delay(); events.push("loaded " + file);
    if (file === "/preload.ts") return;
    api.describe("deferred", async () => { await delay(); events.push("collect"); api.test("owned", () => events.push("body")); });
  }, ["/control.test.ts"], ["/preload.ts"]);
  expect(result.exit).toBe(0);
  expect(events).toEqual(["import /preload.ts", "loaded /preload.ts", "import /control.test.ts", "loaded /control.test.ts", "collect", "body"]);
});

test("a completed A callback cannot register while sibling B is admitted", async () => {
  const gate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const rejected: string[] = [];
  const result = await runner(api => {
    api.describe("A", () => beginLateRegistration(api, gate.promise, rejected, completed.resolve));
    api.describe("B", async () => { gate.resolve(); await completed.promise; api.test("owned B", () => {}); });
    api.test("sentinel", () => {});
  });
  expect(result.exit).toBe(0);
  expect(rejected).toEqual(["test", "describe", "afterAll", "finished"]);
  expect(result.stderr).toContain("B > owned B");
  expect(result.stderr).toContain("2 pass");
});
