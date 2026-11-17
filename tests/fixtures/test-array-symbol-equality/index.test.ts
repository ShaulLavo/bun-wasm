import { expect, test } from "bun:test";

const s = Symbol("s");
const t = Symbol("t");
const withSymbol = (value: unknown) => Object.assign([1], { [s]: value });

test("toEqual compares an array's enumerable symbol keys", () => {
  expect(withSymbol(1)).toEqual(withSymbol(1));
  expect(withSymbol(1)).not.toEqual(withSymbol(2));
  expect(Object.assign([], { [s]: 3 })).not.toEqual(Object.assign([], { [s]: 4 }));
  expect(withSymbol(1)).not.toEqual([1]);
  // Only the received array's symbols are read; loosely, undefined stands for missing.
  expect([1]).toEqual(withSymbol(1));
  expect(withSymbol(undefined)).toEqual([1]);
  expect(Object.assign([1], { [s]: 1, [t]: 2 })).toEqual(Object.assign([1], { [s]: 1, [t]: 2 }));
  expect(withSymbol({ deep: [1] })).toEqual(withSymbol({ deep: [1] }));
  expect(withSymbol(5)).toEqual(withSymbol(expect.any(Number)));
});

test("other array keys are still ignored", () => {
  const hidden = [1];
  Object.defineProperty(hidden, s, { value: 2, enumerable: false });
  expect(hidden).toEqual([1]);
  expect(Object.assign([1], { extra: 1 })).toEqual(Object.assign([1], { extra: 2 }));
  expect(Object.assign([1], { extra: 1 })).toStrictEqual([1]);
});

test("toStrictEqual needs the same symbols on both sides", () => {
  expect(withSymbol(1)).toStrictEqual(withSymbol(1));
  expect(withSymbol(1)).not.toStrictEqual(withSymbol(2));
  expect(withSymbol(undefined)).not.toStrictEqual([1]);
  expect([1]).not.toStrictEqual(withSymbol(1));
});

test("Bun.deepEquals uses the same rule", () => {
  expect(Bun.deepEquals(withSymbol(1), withSymbol(1))).toBe(true);
  expect(Bun.deepEquals(withSymbol(1), withSymbol(2))).toBe(false);
  expect(Bun.deepEquals(withSymbol(1), [1])).toBe(false);
  expect(Bun.deepEquals([1], withSymbol(1))).toBe(true);
  expect(Bun.deepEquals(withSymbol(undefined), [1])).toBe(true);
  expect(Bun.deepEquals(withSymbol(undefined), [1], true)).toBe(false);
  expect(Bun.deepEquals([1], withSymbol(1), true)).toBe(false);
});
