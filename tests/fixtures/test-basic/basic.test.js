import { test, it, expect, describe } from "bun:test";

test("passes", () => {
  expect(1 + 1).toBe(2);
});

test("fails", () => {
  expect(1 + 1).toBe(3);
});

test.skip("skipped", () => {
  throw new Error("never runs");
});

test.todo("todo without body");
test.todo("todo with body", () => {
  throw new Error("todo bodies do not run");
});

test.failing("failing test that fails", () => {
  expect(true).toBe(false);
});
test.failing("failing test that passes", () => {});

describe("outer", () => {
  it("inner pass", () => {});
  describe("nested", () => {
    test("deep fail", () => {
      expect({ a: 1, b: [1, 2] }).toEqual({ a: 1, b: [1, 3] });
    });
    test("deep pass", () => {});
  });
  describe.skip("skipped group", () => {
    test("in skipped group", () => {});
  });
  describe.todo("todo group", () => {
    test("in todo group", () => {});
  });
});
