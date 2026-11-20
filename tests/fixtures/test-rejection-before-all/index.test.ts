import { beforeAll, test, expect } from "bun:test";

// A rejection a hook leaves unhandled is an error between tests in Bun: the hook still
// succeeds and its tests run.
beforeAll(() => {
  Promise.reject(new Error("in beforeAll"));
});

test("a", () => {
  console.log("a ran");
  expect(1).toBe(1);
});

test("b", () => {
  console.log("b ran");
});
