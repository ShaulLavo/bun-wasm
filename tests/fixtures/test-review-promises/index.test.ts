import assert from "node:assert/strict";
import { expect, test } from "bun:test";

test("returned plain objects do not expose then accessors to toThrow", () => {
  let reads = 0;
  const value = { get then() { reads++; throw new Error("getter-error"); } };
  expect(() => value).not.toThrow();
  assert.equal(reads, 0);
  expect(() => expect(() => value).toThrow("getter-error")).toThrow();
  assert.equal(reads, 0);
});

test("returned promises use intrinsic reactions", async () => {
  const reason = new Error("original rejection");
  let reads = 0;
  await expect(() => {
    const promise = Promise.reject(reason);
    Object.defineProperty(promise, "then", { get() {
      if (++reads === 1) return Promise.prototype.then;
      throw new Error("second getter");
    } });
    return promise;
  }).toThrow(reason);
  assert.equal(reads, 0);
  await expect(() => {
    const overridden = Promise.reject(reason);
    Object.defineProperty(overridden, "then", { value() { throw new Error("override"); } });
    return overridden;
  }).toThrow(reason);
});

test("unawaited assertions consume the original promise rejection", async () => {
  let reads = 0;
  expect(() => {
    const promise = Promise.reject(new Error("unawaited rejection"));
    Object.defineProperty(promise, "then", { get() { reads++; throw new Error("getter-error"); } });
    return promise;
  }).toThrow("unawaited rejection");
  await Promise.resolve();
  assert.equal(reads, 0);
});

test("caught async assertion failures remain caught", async () => {
  let caught = false;
  try { await expect(async () => 1).toThrow(); } catch { caught = true; }
  assert.equal(caught, true);
});
