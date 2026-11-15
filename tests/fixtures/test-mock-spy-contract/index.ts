import assert from "node:assert/strict";
import { expect, mock, spyOn } from "bun:test";

const fn = mock(function original(value: unknown) { return value; });
const other = mock(() => "other");
assert.equal(fn.mockName("named"), fn);
fn.mockName("");
assert.equal(fn.getMockName(), "named");
assert.equal(fn.name, "named");
const prototype = Object.getPrototypeOf(fn);
assert.equal(Object.getPrototypeOf(prototype), Function.prototype);
assert.equal(fn.apply, Function.prototype.apply);
for (const key of Reflect.ownKeys(prototype)) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  const method = descriptor?.get ?? descriptor?.value;
  if (typeof method !== "function") continue;
  assert.throws(() => Reflect.apply(method, undefined, []), { code: "ERR_INVALID_THIS" });
}
assert.throws(() => Reflect.apply(fn.mockClear, undefined, []), { code: "ERR_INVALID_THIS" });
Reflect.apply(fn.mockReturnValue, other, ["borrowed"]);
assert.equal(other(), "borrowed");
assert.equal(fn("unchanged"), "unchanged");
assert.equal(Reflect.apply(mock, undefined, [17])(), 17);
const thrown = new Error("implementation");
fn.mockImplementationOnce(() => { throw thrown; });
assert.throws(() => fn("throws"), error => error === thrown);
assert.deepEqual(fn.mock.results[1], { type: "throw", value: thrown });
assert.deepEqual(fn.mock.calls, [["unchanged"], ["throws"]]);
assert.ok(other.mock.invocationCallOrder[0] < fn.mock.invocationCallOrder[0]);
const lastCall = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn.mock), "lastCall")?.get;
assert.equal(typeof lastCall, "function");
if (!lastCall) throw new Error("Missing lastCall getter");
assert.equal(Reflect.apply(lastCall, undefined, []), undefined);
assert.deepEqual(fn.mock.lastCall, ["throws"]);
console.log("mock receiver and shorthand");

const queued = mock(() => "base");
queued.mockImplementationOnce(() => "first").mockImplementationOnce(() => "second");
queued.withImplementation(() => "temporary", () => {
  assert.equal(queued(), "temporary");
});
assert.deepEqual([queued(), queued(), queued()], ["first", "second", "base"]);
await queued.withImplementation(() => "async", async () => {
  await Promise.resolve();
  assert.equal(queued(), "async");
});
assert.equal(queued(), "base");
console.log("temporary implementations restore queues");

const boom = new Error("constructor getter");
const promise = Promise.resolve(1);
Object.defineProperty(promise, "constructor", { get() { throw boom; } });
assert.throws(() => fn.mockResolvedValue(promise), error => error === boom);
assert.throws(() => fn.mockResolvedValueOnce(promise), error => error === boom);
assert.equal(fn("after rejection"), "after rejection");
const resolved = mock().mockResolvedValue(42);
assert.equal(resolved(), resolved());
assert.equal(await resolved(), 42);
console.log("promise wrapping is atomic");

const array = [1, 2, 3];
const property = spyOn(array, 1);
assert.equal(array[1], 2);
array[1] = 20;
assert.equal(array[1], 2);
assert.deepEqual(property.mock.calls, [[], [20], []]);
assert.equal(array.length, 3);
assert.deepEqual([array[0], array[2]], [1, 3]);
assert.throws(() => spyOn(array, 1), /accessor properties/);
property.mockRestore();
assert.deepEqual(array, [1, 2, 3]);
assert.equal(property.mock.calls.length, 0);
const sparse: Record<number, unknown> = {};
const missing = spyOn(sparse, 3221225473);
assert.equal(sparse[3221225473], undefined);
missing.mockRestore();
assert.deepEqual(Object.getOwnPropertyDescriptor(sparse, 3221225473), {
  value: undefined, writable: true, enumerable: true, configurable: true,
});
console.log("indexed property spies restore descriptors");

const called = mock((value: unknown) => value);
called("return");
for (const invalid of [undefined, null, "1", {}, -1, 1.5, NaN, Infinity]) {
  assert.throws(() => Reflect.apply(expect(called).not.toHaveBeenCalledTimes, expect(called).not, [invalid]));
  assert.throws(() => Reflect.apply(expect(called).not.toHaveReturnedTimes, expect(called).not, [invalid]));
}
assert.throws(() => Reflect.apply(expect(called).toHaveBeenCalled, expect(called), [undefined]));
const uncalled = mock();
assert.throws(() => Reflect.apply(expect(uncalled).not.toHaveBeenCalled, expect(uncalled).not, [undefined]));
assert.throws(() => Reflect.apply(expect(uncalled).not.toHaveReturned, expect(uncalled).not, [undefined]));
for (const invalid of [undefined, "1", 0, -1, 1.5, NaN, Infinity]) {
  assert.throws(() => Reflect.apply(expect(called).not.toHaveBeenNthCalledWith, expect(called).not, [invalid, "return"]));
}
expect(called).toHaveBeenCalledTimes(1);
expect(called).toHaveReturnedWith("return");
const results: unknown[] = called.mock.results;
results.push(1);
assert.throws(() => expect(called).toHaveReturned());
assert.throws(() => expect(called).not.toHaveReturnedTimes(0));
results.pop();
results.length = 3;
assert.throws(() => expect(called).toHaveReturned());
console.log("matcher arguments and mutated results");
