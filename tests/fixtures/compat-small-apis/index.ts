import assert from "node:assert/strict";
import { expect } from "bun:test";

assert.equal(Bun.version_with_sha, `v${Bun.version} (${Bun.revision.slice(0, 9)})`);
console.log("version with revision");

for (const [value, tag] of [[new AbortController(), "AbortController"], [new AbortController().signal, "AbortSignal"], [new Event("test"), "Event"], [new EventTarget(), "EventTarget"], [new CustomEvent("test"), "CustomEvent"], [new MessageEvent("message"), "MessageEvent"]]) {
  assert.equal(Object.prototype.toString.call(value), `[object ${tag}]`);
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), Symbol.toStringTag);
  assert.equal(descriptor?.enumerable, false);
  assert.equal(descriptor?.configurable, true);
}
console.log("web interface brands");

expect(1).toBeWithin(1, 2);
expect(2).not.toBeWithin(1, 2);
expect(NaN).not.toBeWithin(1, 2);
expect(() => expect(1).toBeWithin(0)).toThrow("requires 2 arguments");
expect(() => expect(1).toBeWithin("0", 2)).toThrow("first argument to be a number");
console.log("half-open ranges");

await expect(async () => { await Promise.resolve(); throw new TypeError("async failure"); }).toThrow(TypeError);
await expect(async () => 42).not.toThrow();
await expect(() => Promise.reject("rejected string")).toThrow("rejected");
await expect(() => expect(async () => 42).toThrow()).toThrow();
console.log("async throw matchers");

assert.partialDeepStrictEqual([1, { a: 1, b: 2 }, 3], [{ a: 1 }, 3]);
assert.partialDeepStrictEqual(Object.assign(Object.create(null), { a: 1 }), { a: 1 });
assert.partialDeepStrictEqual(Object.assign(new Number(1), { extra: true }), new Number(1));
assert.throws(() => assert.partialDeepStrictEqual(new Number(1), new Number(2)), assert.AssertionError);
assert.partialDeepStrictEqual(new Map([[{ a: 1, b: 2 }, { x: 1, y: 2 }]]), new Map([[{ a: 1 }, { x: 1 }]]));
assert.throws(() => assert.partialDeepStrictEqual([1, 2], [2, 1]), assert.AssertionError);
assert.throws(() => assert.partialDeepStrictEqual(new Uint8Array([1]), new Int8Array([1])), assert.AssertionError);
assert.throws(() => assert.partialDeepStrictEqual([], Object.assign([], { "4294967295": 1 })), assert.AssertionError);
const cyclic: unknown[] = [];
cyclic.push(cyclic);
const expected: unknown[] = [];
expected.push(expected);
assert.partialDeepStrictEqual(cyclic, expected);
assert.throws(() => assert.partialDeepStrictEqual(cyclic, [[1]]), assert.AssertionError);
const shared = { x: 1 };
assert.throws(() => assert.partialDeepStrictEqual([shared, shared], [{ x: 1 }, { x: 2 }]), assert.AssertionError);
console.log("partial strict comparison");
