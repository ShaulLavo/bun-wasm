import { expect, test } from "bun:test";

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "no error";
}

test("the object must contain the subset", () => {
  expect(Bun.deepMatch({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  expect(Bun.deepMatch({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  expect(Bun.deepMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
  expect(Bun.deepMatch({ a: 1 }, { a: 2 })).toBe(false);
  expect(Bun.deepMatch({}, { a: 1 })).toBe(true);
  expect(Bun.deepMatch({ a: undefined }, {})).toBe(false);
  expect(Bun.deepMatch({ a: undefined }, { a: undefined })).toBe(true);
});

test("values compare with Object.is", () => {
  expect(Bun.deepMatch({ a: NaN }, { a: NaN })).toBe(true);
  expect(Bun.deepMatch({ a: 0 }, { a: -0 })).toBe(false);
  expect(Bun.deepMatch({ a: "1" }, { a: 1 })).toBe(false);
});

test("arrays must match exactly", () => {
  expect(Bun.deepMatch([1, 2], [1, 2])).toBe(true);
  expect(Bun.deepMatch([1], [1, 2])).toBe(false);
  expect(Bun.deepMatch({ a: [1] }, { a: [1, 2] })).toBe(false);
  expect(Bun.deepMatch({ a: [{ b: 1 }] }, { a: [{ b: 1, c: 2 }] })).toBe(true);
});

test("symbols and inherited keys", () => {
  const s = Symbol("s");
  expect(Bun.deepMatch({ [s]: 1 }, { [s]: 1, b: 2 })).toBe(true);
  expect(Bun.deepMatch({ [s]: 1 }, { [s]: 2 })).toBe(false);
  expect(Bun.deepMatch({ a: 1 }, Object.create({ a: 1 }))).toBe(true);
  expect(Bun.deepMatch(Object.create({ a: 1 }), { a: 2 })).toBe(false);
});

test("cycles and arguments", () => {
  const object: Record<string, unknown> = { a: 1 };
  object.self = object;
  const subset: Record<string, unknown> = { a: 1 };
  subset.self = subset;
  expect(Bun.deepMatch(subset, object)).toBe(true);
  expect(Bun.deepMatch.length).toBe(2);
  expect(message(() => (Bun.deepMatch as (...values: unknown[]) => boolean)({}))).toBe("TypeError: Expected 2 values to compare");
  expect(message(() => Bun.deepMatch(1 as never, {}))).toBe("TypeError: Expected 2 objects to match");
  expect(message(() => Bun.deepMatch({}, null as never))).toBe("TypeError: Expected 2 objects to match");
});
