import { expect, test } from "bun:test";

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "no error";
}

test("toContainAllKeys", () => {
  expect({ a: 1, b: 2 }).toContainAllKeys(["b", "a"]);
  expect({ a: 1, b: 2 }).not.toContainAllKeys(["a"]);
  expect({ a: 1 }).not.toContainAllKeys(["a", "b"]);
  expect({ 1: "x" }).not.toContainAllKeys([1]);
  expect([1, 2]).toContainAllKeys(["0", "1"]);
  expect({ a: 1, [Symbol("hidden")]: 2 }).toContainAllKeys(["a"]);
  expect({}).toContainAllKeys([]);
  expect(message(() => expect({ a: 1 }).toContainAllKeys(["b"]))).toBe('Error: expect(received).toContainAllKeys(expected)\n\nExpected to contain all keys: [ "b" ]\nReceived: [ "a" ]\n');
  expect(message(() => expect({ a: 1 }).toContainAllKeys("a" as never))).toContain("TypeError");
});

test("toContainValue", () => {
  expect({ a: { b: 1 } }).toContainValue({ b: 1 });
  expect({ a: [1, "x"] }).toContainValue([1, "x"]);
  expect({ a: false }).toContainValue(false);
  expect({ a: 1 }).not.toContainValue(2);
  expect("ab").toContainValue("b");
  expect(null).not.toContainValue(null);
  expect(undefined).not.toContainValue(undefined);
  expect({ a: 5 }).toContainValue(expect.any(Number));
  expect(message(() => expect({ a: 1 }).toContainValue(2))).toBe("Error: expect(received).toContainValue(expected)\n\nExpected to contain: 2\nReceived: {\n  a: 1,\n}\n");
});

test("toContainValues", () => {
  expect({ a: 1, b: "x", c: [1] }).toContainValues([[1], "x"]);
  expect({ a: 1 }).toContainValues([]);
  expect({ a: 1 }).not.toContainValues([1, 2]);
  expect(null).toContainValues(["anything"]);
  expect(undefined).toContainValues([1]);
  expect(message(() => expect({ a: 1 }).toContainValues(1 as never))).toContain("TypeError");
});

test("toContainAllValues", () => {
  expect({ a: 1, b: 2 }).toContainAllValues([2, 1]);
  expect({ a: 1, b: 2 }).not.toContainAllValues([1]);
  expect({ a: 1, b: 1 }).toContainAllValues([1, 1]);
  expect({}).not.toContainAllValues([]);
  expect(null).not.toContainAllValues([]);
  expect(message(() => expect({ a: 1 }).toContainAllValues([2]))).toBe("Error: expect(received).toContainAllValues(expected)\n\nExpected to contain all values: [ 2 ]\nReceived: {\n  a: 1,\n}\n");
});

test("toContainAnyValues", () => {
  expect({ a: 1, b: 2 }).toContainAnyValues([3, 2]);
  expect({ a: 1 }).not.toContainAnyValues([]);
  expect({ a: 1 }).not.toContainAnyValues([2, 3]);
  expect(undefined).not.toContainAnyValues([undefined]);
  expect(message(() => expect({ a: 1 }).not.toContainAnyValues([1]))).toBe("Error: expect(received).not.toContainAnyValues(expected)\n\nExpected to not contain any of the following values: [ 1 ]\nReceived: {\n  a: 1,\n}\n");
});

test("toBeEmptyObject", () => {
  expect({}).toBeEmptyObject();
  expect([]).toBeEmptyObject();
  expect(Object.create(null)).toBeEmptyObject();
  expect({ [Symbol("s")]: 1 }).toBeEmptyObject();
  expect(() => {}).toBeEmptyObject();
  expect(new Map()).not.toBeEmptyObject();
  expect(new Set()).not.toBeEmptyObject();
  expect(/x/).not.toBeEmptyObject();
  expect(new Date()).not.toBeEmptyObject();
  expect({ a: 1 }).not.toBeEmptyObject();
  expect("").not.toBeEmptyObject();
  expect(null).not.toBeEmptyObject();
  expect(message(() => expect({ a: 1 }).toBeEmptyObject())).toBe("Error: expect(received).toBeEmptyObject()\n\nReceived: {\n  a: 1,\n}\n");
});

test("toBeObject counts functions and classes", () => {
  expect(class A {}).toBeObject();
  expect(() => {}).toBeObject();
  expect([]).toBeObject();
  expect(null).not.toBeObject();
  expect("s").not.toBeObject();
});
