import { expect } from "bun:test";

function failure(run: () => unknown): Error {
  try { run(); } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected assertion failure");
}

for (const [a, b] of [
  [new URL("https://example.com/a"), new URL("https://example.com/b")],
  [new URLSearchParams("a=1"), new URLSearchParams("b=1")],
  [new Headers({ a: "1" }), new Headers({ b: "1" })],
]) {
  expect(a).not.toEqual(b);
  expect(a).not.toStrictEqual(b);
  expect(Bun.deepEquals(a, b)).toBe(false);
  expect(Bun.deepEquals(a, b, true)).toBe(false);
}
expect(new URLSearchParams("a=1&b=2")).toEqual(new URLSearchParams("b=2&a=1"));
expect(new Headers({ a: "1", b: "2" })).toEqual(new Headers({ b: "2", a: "1" }));
expect(new URL("https://example.com")).toEqual(new URL("https://example.com/"));
const hiddenURL = Object.defineProperty(new URL("https://example.com/a"), "href", { get() { throw new Error("shadowed href read"); } });
expect(hiddenURL).not.toEqual(new URL("https://example.com/b"));
const hiddenParams = Object.defineProperty(new URLSearchParams("a=1"), "size", { get() { throw new Error("shadowed size read"); } });
expect(hiddenParams).not.toEqual(new URLSearchParams("b=1"));
const hiddenHeaders = Object.defineProperty(new Headers({ a: "1" }), "get", { value: 42 });
expect(new Headers({ a: "2" })).not.toEqual(hiddenHeaders);
console.log("platform contents");

class First extends String {}
class Second extends First {}
class Other extends String {}
expect(new First("a")).toEqual(new First("a"));
expect(new First("a")).not.toEqual(new Second("a"));
expect(new First("a")).not.toEqual(new Other("a"));
expect(new First("a")).not.toEqual(new String("a"));
expect(new String("a")).not.toEqual(new First("a"));
console.log("boxed string constructors");

const events: string[] = [];
const left = [1, undefined, 2];
const right = [1, undefined, 2];
Object.defineProperty(left, 6, { get() { events.push("left"); return 1; } });
Object.defineProperty(right, 6, { get() { events.push("right"); return 2; } });
expect(left).toEqual(right);
expect(left).toStrictEqual(right);
expect(Bun.deepEquals(left, right)).toBe(true);
expect(Bun.deepEquals(left, right, true)).toBe(true);
expect(events).toEqual([]);
expect(left).toEqual([1, undefined, 2, undefined, undefined, undefined, expect.any(Number)]);
expect(events).toEqual(["left"]);
events.length = 0;
expect.extend({ async observed(value: unknown) {
  events.push("start");
  await Promise.resolve();
  events.push("end");
  return { pass: value === 1, message: () => "observed mismatch" };
} });
await expect(left).toEqual([1, undefined, 2, undefined, undefined, undefined, Reflect.apply(Reflect.get(expect, "observed"), expect, [])]);
expect(events).toEqual(["left", "start", "end"]);
events.length = 0;
const proxy = new Proxy([1, 2], { get(target, key, receiver) {
  if (key === "0" || key === "1") events.push(String(key));
  return Reflect.get(target, key, receiver);
} });
expect(proxy).toEqual([1, 2]);
expect(events).toEqual(["0", "1"]);
events.length = 0;
expect(Bun.deepEquals(proxy, [1, 2])).toBe(true);
expect(events).toEqual(["0", "1"]);
console.log("array accessors and awaited matchers");

let calls = 0;
await expect(Promise.resolve(() => { calls++; throw new Error("resolved callback"); })).resolves.toThrow("resolved callback");
await expect(Promise.resolve(new Error("resolved error"))).resolves.toThrow("resolved error");
await expect(Promise.resolve(() => { calls++; })).resolves.not.toThrow();
await expect(Promise.reject(() => { throw new Error("must not invoke rejection"); })).rejects.toThrow();
expect(calls).toBe(2);
console.log("promise throw invocation");

expect(failure(() => expect("a", "label").toBe("b")).message).toContain("label\n\nExpected");
expect(failure(() => expect("a", "label").not.toEqual("a")).message).toContain("label\n\nExpected");
try { await expect(Promise.resolve(1), "promise label").resolves.toBe(2); } catch (error) {
  expect(error instanceof Error && error.message.includes("promise label\n\nExpected")).toBe(true);
}
for (const label of [null, Symbol("label"), 42]) {
  const value = Reflect.apply(expect, undefined, ["a", label]);
  expect(failure(() => value.toBe("b")).message).toContain("expect(received).toBe(expected)");
}
console.log("assertion labels");

const data = Object.defineProperty(new FormData(), "toJSON", { value: 42 });
const message = failure(() => expect(data).toEqual(1)).message;
expect(message).toContain('"toJSON": 42');
expect(message).not.toContain("is not a function");
console.log("non-callable toJSON diagnostics");
