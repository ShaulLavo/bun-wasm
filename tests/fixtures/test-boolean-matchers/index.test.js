import { expect, test } from "bun:test";

test("boolean matchers compare exact values and support negation", async () => {
  expect(true).toBeTrue();
  expect(false).toBeFalse();
  expect(false).not.toBeTrue();
  expect(true).not.toBeFalse();
  for (const value of [0, 1, "", "true", null, undefined, {}, new Boolean(true), new Boolean(false)]) {
    expect(value).not.toBeTrue();
    expect(value).not.toBeFalse();
    expect(() => expect(value).toBeTrue()).toThrow();
    expect(() => expect(value).toBeFalse()).toThrow();
  }
  expect(() => expect(false).toBeTrue()).toThrow();
  expect(() => expect(true).toBeFalse()).toThrow();
  expect(() => expect(true).not.toBeTrue()).toThrow();
  expect(() => expect(false).not.toBeFalse()).toThrow();
  await expect(Promise.resolve(true)).resolves.toBeTrue();
  await expect(Promise.reject(false)).rejects.toBeFalse();
  console.log("exact boolean matchers ok");
});
