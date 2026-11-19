import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "bun:test";

// An uncaught failure from a timer started inside als.run() within a concurrent test is
// reported between tests, as in Bun, and neither test fails.
const als = new AsyncLocalStorage<string>();
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("uncaught", () => {
  test.concurrent("uncaught inside run", async () => {
    await als.run("uncaught-store", async () => {
      await tick();
      // A failed expect, which every engine reports at the same source position.
      setTimeout(() => {
        expect("boom inside run").toBe("caught");
      }, 0);
      await tick();
      await tick();
      console.log("uncaught inside run", als.getStore());
    });
  });
  test.concurrent("beside the uncaught one", async () => {
    await tick();
    console.log("beside", als.getStore());
  });
});
