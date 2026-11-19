import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "bun:test";

const als = new AsyncLocalStorage<string>();
const waiting: (() => void)[] = [];
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  waiting.push(resolve);
  setTimeout(() => waiting.shift()?.(), 0);
  return promise;
}

// A store entered before the group is visible inside each concurrent test, before and after
// it waits.
als.enterWith("before the group");
describe("stores", () => {
  for (const name of ["a", "b"]) {
    test.concurrent(`sees ${name}`, async () => {
      console.log(name, "start", als.getStore());
      await tick();
      console.log(name, "after await", als.getStore());
    });
  }
});

// Tests registered inside als.run() see that store.
als.run("registered", () => {
  test.concurrent("registered inside run", async () => {
    await tick();
    console.log("registered inside run", als.getStore());
  });
});

// Inside als.run(), an assertion still belongs to its own test, and the test beside it is
// unaffected; enterWith() inside a test keeps the test too.
describe("inside als.run", () => {
  test.concurrent("fails inside run", async () => {
    await als.run("run-store", async () => {
      await tick();
      console.log("fails inside run", als.getStore());
      try {
        expect(1).toBe(2);
      } catch (error) {
        throw (error as Error).message.split("\n")[0];
      }
    });
  });
  test.concurrent("passes beside it", async () => {
    await tick();
    await tick();
    console.log("passes beside it", als.getStore());
    expect(1).toBe(1);
  });
  test.concurrent("enterWith inside a test", async () => {
    als.enterWith("entered");
    await tick();
    console.log("enterWith inside a test", als.getStore());
    expect(2).toBe(2);
  });
});
