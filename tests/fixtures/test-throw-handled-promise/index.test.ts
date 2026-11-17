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
