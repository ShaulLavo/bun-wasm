import assert from "node:assert/strict";
import { expect, test } from "bun:test";

for (const property of ["constructor", "species", "then"]) {
  test(`toThrow bypasses a throwing ${property} and handles the original rejection`, async () => {
    const originals = new Set<Promise<unknown>>();
    const leaked: unknown[] = [];
    let reads = 0;
    const onRejection = (reason: unknown, promise: Promise<unknown>) => {
      if (originals.has(promise)) leaked.push(reason);
    };
    const poison = (promise: Promise<unknown>) => {
      const get = () => { reads++; throw new Error(`observed ${property}`); };
      if (property === "species") Object.defineProperty(promise, "constructor", {
        value: { get [Symbol.species]() { return get(); } },
      });
      else Object.defineProperty(promise, property, { get });
      return promise;
    };
    process.on("unhandledRejection", onRejection);
    try {
      const reason = new Error(`original ${property}`);
      const rejected = poison(Promise.reject(reason));
      originals.add(rejected);
      await expect(() => rejected).toThrow(reason);
      const pending = poison(new Promise((_, reject) => setTimeout(() => reject(reason), 1)));
      originals.add(pending);
      await expect(() => pending).toThrow(reason);
      await expect(() => poison(Promise.resolve(123))).not.toThrow();
      const unawaited = poison(Promise.reject(reason));
      originals.add(unawaited);
      expect(() => unawaited).toThrow(reason);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(reads, 0);
      assert.deepEqual(leaked, []);
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }
  });
}

test("toThrow bypasses a replaced Promise.prototype.then", async () => {
  const then = Promise.prototype.then;
  const reason = new Error("original prototype rejection");
  const rejected = Promise.reject(reason);
  let result: unknown;
  let calls = 0;
  try {
    Promise.prototype.then = function () { calls++; throw new Error("patched then"); };
    result = expect(() => rejected).toThrow(reason);
  } finally {
    Promise.prototype.then = then;
  }
  await result;
  assert.equal(calls, 0);
});
