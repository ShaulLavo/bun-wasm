// `bun test` with FORCE_COLOR: native Bun's symbols, colours, highlighted source and diffs.
import { describe, expect, jest, test } from "bun:test";

test("top level pass", () => {
  console.log("log inside a test", { n: 1 });
  expect(1).toBe(1);
});

describe("numbers", () => {
  test("toBe", () => {
    expect(1).toBe(2);
  });
  test("not toBe", () => {
    expect(3).not.toBe(3);
  });
  test("ordering", () => {
    expect(2).toBeGreaterThan(5);
  });
  test("close to", () => {
    expect(0.3).toBeCloseTo(0.5);
  });
});

describe("text", () => {
  test("single-line string", () => {
    expect("hello world").toBe("hello there");
  });
  test("contains", () => {
    expect([1, 2, 3]).toContain(4);
  });
  test("length", () => {
    expect("abc").toHaveLength(5);
  });
  test("pattern", () => {
    expect("abc").toMatch(/z/);
  });
});

describe("objects", () => {
  test("toEqual", () => {
    expect({ a: 1, b: [1, 2, 3], c: "hello" }).toEqual({ a: 1, b: [1, 2, 4], c: "world" });
  });
  test("not toEqual", () => {
    expect([1]).not.toEqual([1]);
  });
  test("truthy", () => {
    expect(0).toBeTruthy();
  });
  test("throws", () => {
    expect(() => {}).toThrow("nope");
  });
  test("mock calls", () => {
    const fn = jest.fn();
    fn(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  test("assertion count", () => {
    expect.assertions(2);
    expect(true).toBe(true);
  });
});

describe("snapshots", () => {
  test("matches", () => {
    expect({ x: 1 }).toMatchSnapshot();
  });
  test("differs", () => {
    expect({ x: 1, y: "new" }).toMatchSnapshot();
  });
});

test.skip("skipped", () => {});
test.todo("todo later");
test.failing("marked failing but passes", () => {});
