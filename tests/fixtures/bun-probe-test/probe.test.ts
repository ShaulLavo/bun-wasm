// The bun:test features a Bun author reaches for first (docs/bun-api-probe.md).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";

const order: string[] = [];
beforeAll(() => order.push("beforeAll"));
afterAll(() => console.log("hooks:", order.join(",")));

describe("math", () => {
  let base = 0;
  beforeEach(() => { base = 40; order.push("beforeEach"); });
  afterEach(() => order.push("afterEach"));

  test("adds", () => {
    expect(base + 2).toBe(42);
    expect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    expect([1, 2, 3]).toContain(2);
    expect("hello world").toMatch(/wor/);
    expect(() => { throw new TypeError("bad"); }).toThrow(TypeError);
    expect(0.1 + 0.2).toBeCloseTo(0.3);
    expect({ id: 1, name: "x" }).toMatchObject({ name: "x" });
    expect(null).toBeNull();
    expect([1, 2]).toHaveLength(2);
  });

  test.each([[1, 1, 2], [2, 3, 5]])("each %i + %i = %i", (a, b, sum) => {
    expect(a + b).toBe(sum);
  });

  test.each([{ name: "a", n: 1 }, { name: "b", n: 2 }])("each object $name", ({ n }) => {
    expect(n).toBeGreaterThan(0);
  });
});

describe("mocks", () => {
  test("mock() records calls", () => {
    const fn = mock((x: number) => x * 2);
    expect(fn(3)).toBe(6);
    fn(4);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith(4);
    expect(fn.mock.calls).toEqual([[3], [4]]);
    expect(fn.mock.results[0]).toEqual({ type: "return", value: 6 });
    fn.mockReturnValue(99);
    expect(fn(1)).toBe(99);
    fn.mockImplementationOnce(() => -1);
    expect(fn(1)).toBe(-1);
    const j = jest.fn().mockResolvedValue("async");
    return expect(j()).resolves.toBe("async");
  });

  test("spyOn wraps and restores", () => {
    const obj = { greet: (name: string) => `hi ${name}` };
    const spy = spyOn(obj, "greet");
    expect(obj.greet("bun")).toBe("hi bun");
    expect(spy).toHaveBeenCalledWith("bun");
    spy.mockImplementation(() => "mocked");
    expect(obj.greet("x")).toBe("mocked");
    spy.mockRestore();
    expect(obj.greet("x")).toBe("hi x");
  });

  test("mock.module replaces later imports and requires", async () => {
    mock.module("./dep.ts", () => ({ value: () => "mocked module" }));
    expect((await import("./dep.ts")).value()).toBe("mocked module");
    expect((await import("./dep")).value()).toBe("mocked module");
    expect(require("./dep.ts").value()).toBe("mocked module");
  });
});

describe("snapshots", () => {
  test("file snapshot", () => {
    expect({ engine: "any", list: [1, "two", { three: 3 }] }).toMatchSnapshot();
  });
  test("inline snapshot", () => {
    expect({ a: 1, b: "x" }).toMatchInlineSnapshot(`
{
  "a": 1,
  "b": "x",
}
`);
  });
});

describe("async and modifiers", () => {
  test("awaits promises", async () => {
    await Bun.sleep(1);
    await expect(Promise.reject(new Error("nope"))).rejects.toThrow("nope");
  });
  test.skip("skipped", () => { throw new Error("should not run"); });
  test.todo("todo later");
  test.if(true)("conditional", () => expect(true).toBeTrue());
  test("expect.assertions", () => {
    expect.assertions(1);
    expect(1).toBeTruthy();
  });
  test("asymmetric matchers", () => {
    expect({ id: 7, at: new Date(0), tags: ["x"] }).toEqual({ id: expect.any(Number), at: expect.anything(), tags: expect.arrayContaining(["x"]) });
  });
});
