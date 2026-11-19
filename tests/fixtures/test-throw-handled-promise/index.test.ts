import { expect, test } from "bun:test";

test("a promise thrown into toThrow is handled", () => {
  expect(() => {
    throw Promise.reject(Symbol("thrown"));
  }).toThrow();
});

test("a later timer test sees no stray rejection", async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(1).toBe(1);
});

// Only a rejection during the call is captured: a pending promise that rejects after toThrow
// returns is still an unhandled rejection of this test.
test("a pending promise that rejects later is still reported", async () => {
  let reject: (reason: unknown) => void = () => {};
  const pending = new Promise((_, rejectPending) => { reject = rejectPending; });
  expect(() => {
    throw pending;
  }).toThrow();
  reject(Symbol("later"));
  await new Promise(resolve => setTimeout(resolve, 10));
});
