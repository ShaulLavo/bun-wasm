import { expect, test } from "bun:test";

process.on("unhandledRejection", reason => {
  console.log("listener saw", String(reason));
  throw new Error("thrown by the listener");
});

Promise.reject(new Error("unhandled at module scope"));

test("first", () => {
  console.log("first ran");
  expect(1).toBe(1);
});

test("second", () => {
  console.log("second ran");
  expect(2).toBe(2);
});
