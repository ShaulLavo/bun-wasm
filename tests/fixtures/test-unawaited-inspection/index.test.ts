import { expect, test } from "bun:test";

test("constructor inspection does not consume a failed assertion", () => {
  const promise = expect(async () => 1).toThrow();
  void promise.constructor;
  Promise.resolve(promise);
});
