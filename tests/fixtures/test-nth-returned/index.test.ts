import { expect, mock, test } from "bun:test";

test("nth return follows call order through throws and undefined", () => {
  const fn = mock((mode: string) => {
    if (mode === "throw") throw undefined;
    if (mode === "undefined") return undefined;
    return { nested: [mode] };
  });
  fn("first");
  try { fn("throw"); } catch {}
  fn("undefined");
  fn("last");

  expect(fn).toHaveNthReturnedWith(1, { nested: ["first"] });
  expect(fn).not.toHaveNthReturnedWith(1, { nested: ["last"] });
  expect(fn).not.toHaveNthReturnedWith(2, undefined);
  expect(fn).toHaveNthReturnedWith(3, undefined);
  expect(fn).toHaveNthReturnedWith(4, { nested: ["last"] });
  expect(fn).not.toHaveNthReturnedWith(5, undefined);
  expect(() => expect(fn).toHaveNthReturnedWith(2, undefined)).toThrow("Call 2 threw an error");
  expect(() => expect(fn).toHaveNthReturnedWith(5, undefined)).toThrow("call 5 was requested");
});

test("nth return handles empty mocks and omitted expected values", () => {
  const fn = mock(() => undefined);
  expect(fn).not.toHaveNthReturnedWith(1, undefined);
  expect(() => expect(fn).toHaveNthReturnedWith(1, undefined)).toThrow();
  fn();
  Reflect.apply(expect(fn).toHaveNthReturnedWith, expect(fn), [1]);
  expect(() => expect(fn).not.toHaveNthReturnedWith(1, undefined)).toThrow();
});

test("nth return validates the index with and without negation", () => {
  const fn = mock(() => "value");
  fn();
  for (const nth of [undefined, null, "1", 1n, NaN, Infinity, -Infinity, -0, 0.5, 2 ** 51, Number.MAX_SAFE_INTEGER, -(2 ** 51) - 1, {}, [], () => 1]) {
    const positive = expect(fn);
    const negative = expect(fn).not;
    expect(() => Reflect.apply(positive.toHaveNthReturnedWith, positive, [nth, "value"])).toThrow("first argument must be an integer");
    expect(() => Reflect.apply(negative.toHaveNthReturnedWith, negative, [nth, "value"])).toThrow("first argument must be an integer");
  }
  for (const nth of [0, -1]) {
    expect(() => expect(fn).toHaveNthReturnedWith(nth, "value")).toThrow("n must be greater than 0");
    expect(() => expect(fn).not.toHaveNthReturnedWith(nth, "value")).toThrow("n must be greater than 0");
  }
  expect(() => expect(() => 1).not.toHaveNthReturnedWith(1, 1)).toThrow("mock function");
});

test("nth return uses deep equality and asymmetric matching", () => {
  const fn = mock(() => ({ values: new Map([["key", new Set([1, 2])]]), name: "match" }));
  fn();
  expect(fn).toHaveNthReturnedWith(1, { values: new Map([["key", new Set([1, 2])]]), name: "match" });
  expect(fn).toHaveNthReturnedWith(1, expect.objectContaining({ name: expect.any(String) }));
  const assertion = expect(fn);
  Reflect.apply(Reflect.get(assertion, "nthReturnedWith"), assertion, [1, expect.objectContaining({ name: "match" })]);
  expect(fn).not.toHaveNthReturnedWith(1, { values: new Map([["key", new Set([3])]]), name: "match" });
});

test("nth return leaves incomplete recursive calls in their original positions", () => {
  const fn = mock((depth: number): number => {
    if (depth === 0) return 0;
    const value = fn(depth - 1);
    if (depth !== 1) return depth + value;
    expect(fn).not.toHaveNthReturnedWith(1, 3);
    expect(fn).not.toHaveNthReturnedWith(2, 1);
    expect(fn).toHaveNthReturnedWith(3, 0);
    return depth + value;
  });
  fn(2);
  expect(fn).toHaveNthReturnedWith(1, 3);
  expect(fn).toHaveNthReturnedWith(2, 1);
  expect(fn).toHaveNthReturnedWith(3, 0);
});
