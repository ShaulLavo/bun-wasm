import { expect, test } from "bun:test";

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "no error";
}

test("closeTo and not.closeTo", () => {
  expect(1.229).toEqual(expect.closeTo(1.23));
  expect(1.229).not.toEqual(expect.not.closeTo(1.23));
  expect(1.23).toEqual(expect.not.closeTo(1));
  expect(Infinity).not.toEqual(expect.not.closeTo(Infinity));
  expect(3e-7).toEqual(expect.not.closeTo(3.141592e-7, 8));
  // A non-number fails both forms; not does not turn it into a match.
  expect("a").not.toEqual(expect.closeTo(1));
  expect("a").not.toEqual(expect.not.closeTo(1));
  expect(message(() => expect.closeTo("a" as never))).toBe("Error: expect.closeTo(number, precision?)\n\nExpected a number value");
  expect(message(() => expect.not.closeTo("a" as never))).toBe("Error: expect.closeTo(number, precision?)\n\nExpected a number value");
  expect(message(() => expect.closeTo(1, "a" as never))).toBe("Error: expect.closeTo(number, precision?)\n\nPrecision must be a number or undefined");
  expect(message(() => expect.closeTo(1, undefined))).toBe("no error");
});

test("any follows typeof and constructors", () => {
  expect(null).toEqual(expect.any(Object));
  expect([]).toEqual(expect.any(Object));
  expect(() => {}).not.toEqual(expect.any(Object));
  expect(undefined).not.toEqual(expect.any(Object));
  expect(Object(1n)).toEqual(expect.any(BigInt));
  expect(Object(Symbol())).toEqual(expect.any(Symbol));
  expect(new Number(1)).toEqual(expect.any(Number));
  expect(5).toEqual(expect.not.any(String));
  expect(5).not.toEqual(expect.not.any(Number));
  expect(null).not.toEqual(expect.not.any(Object));
  expect(() => {}).toEqual(expect.not.any(Object));
  expect({ a: 1 }).toEqual({ a: expect.not.any(String) });
  expect(message(() => expect.any((() => {}) as never))).toBe("Error: expect.any(constructor)\n\nExpected a constructor\n");
  expect(message(() => expect.not.any(5 as never))).toBe("Error: expect.any(constructor)\n\nExpected a constructor\n");
  expect(message(() => (expect.any as (...values: unknown[]) => unknown)())).toContain("any() expects to be passed a constructor function.");
});

test("anything and its inverse", () => {
  expect(0).toEqual(expect.anything());
  expect(null).toEqual(expect.not.anything());
  expect(0).not.toEqual(expect.not.anything());
});

test("objectContaining compares enumerable symbol keys", () => {
  const a = Symbol("a");
  const b = Symbol("b");
  expect({ [a]: 1 }).toEqual(expect.objectContaining({ [a]: 1 }));
  expect({ [b]: 1 }).not.toEqual(expect.objectContaining({ [a]: 1 }));
  expect({ [b]: 1 }).toEqual(expect.not.objectContaining({ [a]: 1 }));
  const hidden = {};
  Object.defineProperty(hidden, a, { value: 1, enumerable: false });
  expect({}).toEqual(expect.objectContaining(hidden));
  expect(Object.create({ inherited: 1 })).toEqual(expect.objectContaining({ inherited: 1 }));
});

test("factories reject invalid samples", () => {
  const objectError = "Error: expect.objectContaining(object)\n\nExpected an object\n";
  expect(message(() => expect.objectContaining(1337 as never))).toBe(objectError);
  expect(message(() => expect.not.objectContaining(null as never))).toBe(objectError);
  expect(message(() => expect.objectContaining((() => {}) as never))).toBe("no error");
  const stringError = "Error: expect.stringContaining(string)\n\nExpected a string\n";
  expect(message(() => expect.stringContaining([1] as never))).toBe(stringError);
  expect(message(() => expect.not.stringContaining([1] as never))).toBe(stringError);
  const patternError = "Error: expect.stringContaining(string)\n\nExpected a string or regular expression\n";
  expect(message(() => expect.stringMatching([1] as never))).toBe(patternError);
  expect(message(() => expect.not.stringMatching(1 as never))).toBe(patternError);
  expect(message(() => expect.arrayContaining({} as never))).toBe("Error: expect.arrayContaining(array)\n\nExpected a array\n");
  expect(message(() => expect.not.arrayContaining("ab" as never))).toBe("Error: expect.arrayContaining(array)\n\nExpected a array\n");
});

test("resolvesTo and rejectsTo match settled promises", async () => {
  await expect(Promise.resolve("1")).toEqual(expect.resolvesTo.stringContaining("1"));
  await expect(Promise.reject("1")).toEqual(expect.rejectsTo.stringContaining("1"));
  await expect(Promise.resolve("2")).toEqual(expect.not.resolvesTo.stringContaining("1"));
  await expect(Promise.reject("2")).toEqual(expect.rejectsTo.not.stringContaining("1"));
  await expect({ a: Promise.resolve(5) }).toEqual({ a: expect.resolvesTo.any(Number) });
  await expect(Promise.resolve(1.229)).toEqual(expect.resolvesTo.closeTo(1.23));
  await expect(new Promise(resolve => setTimeout(() => resolve("later"), 0))).toEqual(expect.resolvesTo.stringContaining("later"));
  // The wrong settlement and non-promises fail before not inverts the result.
  await expect(Promise.resolve("a")).not.toEqual(expect.rejectsTo.stringContaining("a"));
  await expect(Promise.reject("a")).not.toEqual(expect.resolvesTo.stringContaining("a"));
  await expect(Promise.reject(5)).toEqual(expect.not.resolvesTo.any(Number));
  await expect("a").not.toEqual(expect.resolvesTo.stringContaining("a"));
  await expect("a").toEqual(expect.not.resolvesTo.stringContaining("a"));
  await expect({ then(resolve: (value: string) => void) { resolve("a"); } }).not.toEqual(expect.resolvesTo.stringContaining("a"));
  // The settled value is read without the promise's public then.
  const patched = Promise.resolve("own");
  Object.defineProperty(patched, "then", { value() { throw new Error("public then read"); } });
  await expect(patched).toEqual(expect.resolvesTo.stringContaining("own"));
  expect(message(() => expect.resolvesTo.rejectsTo)).toBe("Error: expect.rejectsTo: already called expect.resolvesTo on this chain");
  expect(message(() => expect.rejectsTo.not.resolvesTo)).toBe("Error: expect.resolvesTo: already called expect.rejectsTo on this chain");
});

test("printed forms", () => {
  expect(Bun.inspect(expect.not.any(Number))).toBe("NotAny<Number>");
  expect(Bun.inspect(expect.not.anything())).toBe("NotAnything");
  expect(Bun.inspect(expect.resolvesTo.stringContaining("a"))).toBe('promise resolved to StringContaining "a"');
  expect(Bun.inspect(expect.not.rejectsTo.any(String))).toBe("promise rejected to NotAny<String>");
  expect(message(() => expect(1).toEqual(expect.not.any(Number)))).toBe("Error: expect(received).toEqual(expected)\n\nExpected: NotAny<Number>\nReceived: 1\n");
  expect(message(() => expect(5).toEqual(expect.resolvesTo.any(Number)))).toBe("Error: expect(received).toEqual(expected)\n\nExpected: promise resolved to Any<Number>\nReceived: 5\n");
});
