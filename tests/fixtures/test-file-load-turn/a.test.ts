import { expect, test } from "bun:test";

// Bun runs one event loop turn after it loads a test file: the immediates the file queued run
// before its first test.
setImmediate(() => console.log("a: immediate"));

test("a runs after the load turn", () => {
  console.log("a: test");
  expect(1).toBe(1);
});
