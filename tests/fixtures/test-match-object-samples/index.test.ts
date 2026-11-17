import { expect, test } from "bun:test";

const f = Symbol("f");
const b = Symbol("b");

test("toMatchObject compares the expected object's enumerable symbol keys", () => {
  expect({ [f]: 2 }).toMatchObject({ [f]: 2 });
  expect({ [f]: 2 }).toMatchObject({ [f]: expect.anything() });
  expect({ [f]: new Date() }).toMatchObject({ [f]: expect.any(Date) });
  expect({ [f]: new Date() }).not.toMatchObject({ [f]: expect.any(RegExp) });
  expect({ [f]: 3 }).not.toMatchObject({ [f]: 5 });
  expect({ [f]: 3 }).not.toMatchObject({ [b]: 3 });
  expect({ a: 1 }).not.toMatchObject({ [f]: 3 });
  expect({ a: 1, [f]: 2, [b]: 3 }).toMatchObject({ [f]: 2 });
  expect({ nested: { [f]: 1, other: 2 } }).toMatchObject({ nested: { [f]: 1 } });
  expect({ nested: { [f]: 1 } }).not.toMatchObject({ nested: { [f]: 2 } });
});

test("string matchers accept String objects as their sample", () => {
  class DString extends String {}
  expect({ a: "hello String" }).toMatchObject({ a: expect.stringContaining(new String("Str") as never) });
  expect({ a: "hello String" }).not.toMatchObject({ a: expect.stringContaining(new String("Strs") as never) });
  expect({ a: "hello derived String" }).toMatchObject({ a: expect.stringContaining(new DString("riv") as never) });
  expect(Bun.inspect(expect.stringContaining(new String("Str") as never))).toBe('StringContaining "Str"');
  // stringMatching accepts a String object but, in Bun, never matches with it.
  expect("a Str").not.toEqual(expect.stringMatching(new String("Str") as never));
  expect(Bun.inspect(expect.stringMatching(new String("Str") as never))).toBe('StringMatching "Str"');
});

test("a non-enumerable symbol in the expected object is ignored", () => {
  const pattern = {};
  Object.defineProperty(pattern, f, { value: 9, enumerable: false });
  expect({}).toMatchObject(pattern);
});
