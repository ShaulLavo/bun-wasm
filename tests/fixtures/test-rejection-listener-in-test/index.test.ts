import { expect, test } from "bun:test";

// Bun's test runner reports unhandled rejections itself; it never calls the program's own
// 'unhandledRejection' listeners, so this one's throw never surfaces.
process.on("unhandledRejection", reason => {
  console.log("listener saw", String(reason));
  throw new Error("thrown by the listener");
});

test("before", () => {
  expect(1).toBe(1);
});

test("rejects without a handler", async () => {
  Promise.reject(new Error("unhandled inside a test"));
  await new Promise(resolve => setTimeout(resolve, 10));
});

test("after", () => {
  expect(2).toBe(2);
});
