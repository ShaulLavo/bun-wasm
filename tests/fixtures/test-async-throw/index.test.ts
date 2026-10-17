import { expect, test } from "bun:test";

test("waits for an unawaited async throw assertion", () => {
  expect(async () => { await Bun.sleep(5); throw new TypeError("later"); }).toThrow(TypeError);
});

test.failing("an unawaited async throw mismatch fails the test", () => {
  expect(async () => { await Bun.sleep(5); return 1; }).toThrow();
});

test("awaited failures can be asserted without poisoning the test", async () => {
  await expect(() => expect(async () => 1).toThrow()).toThrow();
  expect(1).toBe(1);
});
