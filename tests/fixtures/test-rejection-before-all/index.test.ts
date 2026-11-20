import { beforeAll, test, expect } from "bun:test";

// A rejection a hook leaves unhandled is an error between tests in Bun: the hook still
// succeeds and its tests run. The hook waits on a timer, so the rejection is reported while it
// runs on every engine.
beforeAll(async () => {
  Promise.reject(new Error("in beforeAll"));
  await Bun.sleep(5);
});

test("a", () => {
  console.log("a ran");
  expect(1).toBe(1);
});

test("b", () => {
  console.log("b ran");
});
