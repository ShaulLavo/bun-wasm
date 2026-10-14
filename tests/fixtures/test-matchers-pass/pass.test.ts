import { test, expect, describe } from "bun:test";

class Point {
  constructor(public x: number, public y: number) {}
}

describe("equality", () => {
  test("toBe", () => {
    expect(1).toBe(1);
    expect(NaN).toBe(NaN);
    expect(0).not.toBe(-0);
    expect({}).not.toBe({});
  });
  test("toEqual", () => {
    expect({ a: [1, { b: 2 }], c: undefined }).toEqual({ a: [1, { b: 2 }] });
    expect(new Map([["k", [1]]])).toEqual(new Map([["k", [1]]]));
    expect(new Set([1, 2])).toEqual(new Set([2, 1]));
    expect(new Date(5)).toEqual(new Date(5));
    expect([1, 2]).not.toEqual([1, 2, 3]);
    expect(new Point(1, 2)).toEqual({ x: 1, y: 2 });
  });
  test("toStrictEqual", () => {
    expect({ a: 1 }).toStrictEqual({ a: 1 });
    expect({ a: undefined }).not.toStrictEqual({});
    expect(new Point(1, 2)).not.toStrictEqual({ x: 1, y: 2 });
  });
  test("asymmetric", () => {
    expect({ id: 7, name: "bun", tags: ["a", "b"], when: new Date() }).toEqual({
      id: expect.any(Number),
      name: expect.stringContaining("u"),
      tags: expect.arrayContaining(["b"]),
      when: expect.anything(),
    });
    expect("hello").toEqual(expect.stringMatching(/^h.*o$/));
    expect({ a: 1, b: 2 }).toEqual(expect.objectContaining({ a: 1 }));
    expect([{ x: 1, y: 2 }]).toEqual([expect.objectContaining({ y: 2 })]);
    expect(new Point(1, 2)).toEqual(expect.any(Point));
    expect("x").toEqual(expect.not.stringContaining("y"));
  });
  test("toMatchObject", () => {
    expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    expect([{ a: 1, b: 2 }]).toMatchObject([{ a: 1 }]);
    expect({ a: 1 }).not.toMatchObject({ a: 2 });
  });
});

describe("values", () => {
  test("truthiness", () => {
    expect(1).toBeTruthy();
    expect("").toBeFalsy();
    expect(null).toBeNull();
    expect(undefined).toBeUndefined();
    expect(0).toBeDefined();
    expect(NaN).toBeNaN();
    expect(1).not.toBeNaN();
    expect(null).not.toBeUndefined();
  });
  test("numbers", () => {
    expect(3).toBeGreaterThan(2);
    expect(3).toBeGreaterThanOrEqual(3);
    expect(1).toBeLessThan(2);
    expect(2).toBeLessThanOrEqual(2);
    expect(0.1 + 0.2).toBeCloseTo(0.3);
    expect(0.1 + 0.2).not.toBeCloseTo(0.4);
    expect(1.234).toBeCloseTo(1.23, 2);
  });
  test("containers", () => {
    expect([1, 2, 3]).toContain(2);
    expect("hello").toContain("ell");
    expect(new Set(["a"])).toContain("a");
    expect([{ a: 1 }]).toContainEqual({ a: 1 });
    expect([1, 2]).not.toContain(3);
    expect([1, 2]).toHaveLength(2);
    expect("abc").toHaveLength(3);
    expect({ a: { b: [1, { c: 3 }] } }).toHaveProperty("a.b[1].c", 3);
    expect({ a: { b: 1 } }).toHaveProperty(["a", "b"]);
    expect({ a: 1 }).not.toHaveProperty("b");
  });
  test("strings and types", () => {
    expect("hello world").toMatch(/wor/);
    expect("hello world").toMatch("lo w");
    expect("abc").not.toMatch(/z/);
    expect([]).toBeInstanceOf(Array);
    expect(new Point(0, 0)).toBeInstanceOf(Point);
    expect(1).toBeTypeOf("number");
    expect(() => {}).toBeTypeOf("function");
    expect(null).toBeTypeOf("object");
    expect("s").not.toBeTypeOf("number");
  });
  test("toThrow", () => {
    const boom = () => {
      throw new TypeError("boom happened");
    };
    expect(boom).toThrow();
    expect(boom).toThrow("happened");
    expect(boom).toThrow(/^boom/);
    expect(boom).toThrow(TypeError);
    expect(boom).toThrow(Error);
    expect(boom).toThrow(new Error("boom happened"));
    expect(boom).toThrowError("boom");
    expect(() => {}).not.toThrow();
    expect(boom).not.toThrow("other");
    expect(boom).not.toThrow(RangeError);
  });
  test("expect.assertions", () => {
    expect.assertions(2);
    expect(1).toBe(1);
    expect(2).toBe(2);
  });
  test("expect.hasAssertions", () => {
    expect.hasAssertions();
    expect(true).toBeTruthy();
  });
});

describe("extend", () => {
  expect.extend({
    toBeEvenNumber(received: number) {
      return { pass: received % 2 === 0, message: () => `expected ${received} to be even` };
    },
  });
  test("custom matcher", () => {
    (expect(4) as any).toBeEvenNumber();
    (expect(3) as any).not.toBeEvenNumber();
    expect({ n: 2 }).toEqual({ n: (expect as any).toBeEvenNumber() });
  });
});
