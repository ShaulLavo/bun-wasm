import { test } from "bun:test";
import assert from "node:assert/strict";
import { observePromise } from "../src/promise-reactions.ts";

const nativeThen = Function.prototype.call.bind(Promise.prototype.then);

test("reaction attachment restores configurable constructor and species descriptors", async () => {
  for (const property of ["constructor", "species"]) {
    let reads = 0;
    const promise = Promise.resolve(1);
    const get = () => { reads++; throw new Error(`observed ${property}`); };
    const constructor = property === "species" ? { value: { get [Symbol.species]() { return get(); } }, configurable: true } : { get, configurable: true };
    Object.defineProperty(promise, "constructor", constructor);
    const before = Object.getOwnPropertyDescriptor(promise, "constructor");
    const observed = observePromise(promise, value => assert.equal(value, 1));
    assert.deepEqual(Object.getOwnPropertyDescriptor(promise, "constructor"), before);
    await observed;
    assert.equal(reads, 0);
  }
});

test("reaction attachment avoids a patched intrinsic species getter", async () => {
  const promise = Promise.resolve(1);
  const descriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  assert.ok(descriptor);
  let reads = 0;
  let observed: Promise<unknown>;
  try {
    Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { reads++; throw new Error("global species"); } });
    observed = observePromise(promise, value => assert.equal(value, 1));
  } finally {
    Object.defineProperty(Promise, Symbol.species, descriptor);
  }
  await observed;
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn(promise, "constructor"), false);
});

test("modifiable existing constructors work on locked or non-extensible promises", async () => {
  const writable = Promise.resolve(1);
  Object.defineProperty(writable, "constructor", { value: {}, writable: true });
  const sealed = Promise.resolve(2);
  Object.defineProperty(sealed, "constructor", { configurable: true, get() { throw new Error("getter"); } });
  Object.preventExtensions(sealed);
  for (const promise of [writable, sealed]) {
    const before = Object.getOwnPropertyDescriptor(promise, "constructor");
    await observePromise(promise, () => undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(promise, "constructor"), before);
  }
});

test("ordinary frozen promises need no constructor mutation", async () => {
  const promise = Object.freeze(Promise.resolve(1));
  await observePromise(promise, value => assert.equal(value, 1));
  assert.equal(Object.hasOwn(promise, "constructor"), false);
});

test("locked accessors report the browser limitation without invoking getters", () => {
  const promise = Promise.resolve(1);
  let reads = 0;
  Object.defineProperty(promise, "constructor", { get() { reads++; throw new Error("user getter"); } });
  assert.throws(() => observePromise(promise), /browser engine cannot observe.*non-configurable constructor accessor/i);
  assert.equal(reads, 0);
});

test("native reactions retain rejection identity without reading public then", async () => {
  const reason = new Error("original");
  const promise = Promise.reject(reason);
  const handled = nativeThen(promise, undefined, () => undefined);
  let reads = 0;
  Object.defineProperty(promise, "constructor", { configurable: true, get() { reads++; throw new Error("constructor"); } });
  Object.defineProperty(promise, "then", { get() { reads++; throw new Error("then"); } });
  await observePromise(promise, undefined, error => assert.equal(error, reason));
  await handled;
  assert.equal(reads, 0);
});

test("reaction attachment preserves native job ordering and accessor identity", async () => {
  const order: string[] = [];
  let reads = 0;
  const value = { get then() { reads++; return undefined; } };
  const promise = Promise.resolve(value);
  const observed = observePromise(promise, received => { order.push("observed"); assert.equal(received, value); });
  const control = nativeThen(promise, () => order.push("native"));
  queueMicrotask(() => order.push("microtask"));
  await observed;
  await control;
  assert.deepEqual(order, ["observed", "native", "microtask"]);
  assert.equal(reads, 1);
  assert.equal(Object.hasOwn(promise, "constructor"), false);
});

test("constructor restoration also runs when native attachment rejects a receiver", () => {
  const fake = Object.create(Promise.prototype);
  assert.throws(() => observePromise(fake), TypeError);
  assert.equal(Object.hasOwn(fake, "constructor"), false);
});

test("immutable unsafe species and frozen inherited constructors report zero getter reads", () => {
  let reads = 0;
  const readOnly = Promise.resolve(1);
  const constructor = Object.freeze({ get [Symbol.species]() { reads++; throw new Error("species"); } });
  Object.defineProperty(readOnly, "constructor", { value: constructor });
  assert.throws(() => observePromise(readOnly), /read-only constructor with unsafe species/);
  const prototype = Object.freeze(Object.create(Promise.prototype, { constructor: { get() { reads++; throw new Error("inherited"); } } }));
  const locked = Object.preventExtensions(Object.setPrototypeOf(Promise.resolve(1), prototype));
  assert.throws(() => observePromise(locked), /non-extensible promise with unsafe constructor or species/);
  assert.equal(reads, 0);
});
