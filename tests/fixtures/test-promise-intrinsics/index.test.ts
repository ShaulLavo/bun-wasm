import assert from "node:assert/strict";
import { expect, test } from "bun:test";

const browserHost = process.env.BUNWASM_TEST_HOST === "node";

async function checkPoisoned(property: string, configurable: boolean) {
  const originals = new Set<Promise<unknown>>();
  const leaked: unknown[] = [];
  let reads = 0;
  const onRejection = (reason: unknown, promise: Promise<unknown>) => {
    if (originals.has(promise)) leaked.push(reason);
  };
  const poison = (promise: Promise<unknown>) => {
    const get = () => { reads++; throw new Error(`observed ${property}`); };
    if (property === "species") {
      const constructor = { get [Symbol.species]() { return get(); } };
      Object.defineProperty(promise, "constructor", { value: configurable ? constructor : Object.freeze(constructor), configurable });
    }
    else Object.defineProperty(promise, property, { get, configurable });
    return promise;
  };
  process.on("unhandledRejection", onRejection);
  try {
    const reason = new Error(`original ${property}`);
    await expect(() => {
      const rejected = poison(Promise.reject(reason));
      originals.add(rejected);
      return rejected;
    }).toThrow(reason);
    await expect(() => {
      const pending = poison(new Promise((_, reject) => setTimeout(() => reject(reason), 1)));
      originals.add(pending);
      return pending;
    }).toThrow(reason);
    await expect(() => poison(Promise.resolve(123))).not.toThrow();
    expect(() => {
      const unawaited = poison(Promise.reject(reason));
      originals.add(unawaited);
      return unawaited;
    }).toThrow(reason);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reads, 0);
    assert.deepEqual(leaked, []);
  } finally {
    process.removeListener("unhandledRejection", onRejection);
  }
}

for (const configurable of [true, false]) {
  for (const property of ["constructor", "species", "then"]) {
    const limited = !configurable && property !== "then";
    const name = `toThrow bypasses a throwing ${configurable ? "configurable" : "immutable"} ${property} and handles the original rejection${limited ? " (browser limitation)" : ""}`;
    test.todoIf(browserHost && limited)(name, () => checkPoisoned(property, configurable));
  }
}

test("toThrow bypasses a replaced Promise.prototype.then", async () => {
  const then = Promise.prototype.then;
  const reason = new Error("original prototype rejection");
  let result: unknown;
  let calls = 0;
  try {
    Promise.prototype.then = function () { calls++; throw new Error("patched then"); };
    result = expect(() => Promise.reject(reason)).toThrow(reason);
  } finally {
    Promise.prototype.then = then;
  }
  await result;
  assert.equal(calls, 0);
});

test("toThrow handles ordinary frozen promises", async () => {
  const reason = new Error("frozen rejection");
  await expect(() => Object.freeze(Promise.reject(reason))).toThrow(reason);
});

test("toThrow bypasses an inherited constructor getter", async () => {
  const reason = new Error("prototype rejection");
  let reads = 0;
  const prototype = Object.create(Promise.prototype, { constructor: { get() { reads++; throw new Error("inherited constructor"); } } });
  await expect(() => Object.setPrototypeOf(Promise.reject(reason), prototype)).toThrow(reason);
  assert.equal(reads, 0);
});

test.todoIf(browserHost)("native promises without the Promise prototype chain (browser limitation)", async () => {
  const reason = new Error("changed prototype");
  await expect(() => Object.setPrototypeOf(Promise.reject(reason), null)).toThrow(reason);
});

test.skipIf(!browserHost)("browser immutable-constructor diagnostic preserves an existing rejection handler", async () => {
  const promise = Promise.reject(new Error("already handled"));
  const handled = promise.catch(() => undefined);
  let reads = 0;
  Object.defineProperty(promise, "constructor", { get() { reads++; throw new Error("user constructor"); } });
  assert.throws(() => expect(() => promise).toThrow(), /browser engine cannot observe.*non-configurable constructor accessor/);
  await handled;
  assert.equal(reads, 0);
});

test.skipIf(!process.versions.quickjs)("runtime matcher reactions preserve three native job boundaries", async () => {
  const order: Array<string | number> = [];
  const reason = new Error("ordered rejection");
  const assertion = expect(() => Promise.reject(reason)).toThrow(reason);
  let tick = 0;
  const checkpoint = () => { order.push(++tick); if (tick < 4) queueMicrotask(checkpoint); };
  queueMicrotask(checkpoint);
  await assertion;
  order.push("matcher");
  await Promise.resolve();
  assert.deepEqual(order, [1, 2, 3, "matcher", 4]);
});

test.todoIf(browserHost)("non-extensible promises with frozen constructor prototypes (browser limitation)", async () => {
  const reason = new Error("non-extensible prototype rejection");
  const prototype = Object.freeze(Object.create(Promise.prototype, { constructor: { get() { throw new Error("locked inherited constructor"); } } }));
  await expect(() => Object.preventExtensions(Object.setPrototypeOf(Promise.reject(reason), prototype))).toThrow(reason);
});

test("public then preserves custom species behavior", async () => {
  class ResultPromise extends Promise<unknown> {}
  let reads = 0;
  const promise = Promise.resolve(1);
  Object.defineProperty(promise, "constructor", { value: { get [Symbol.species]() { reads++; return ResultPromise; } } });
  const result = promise.then(value => value + 1);
  assert.equal(result instanceof ResultPromise, true);
  assert.equal(reads, 1);
  assert.equal(await result, 2);
  assert.equal(reads, 1);
});

test("matcher promise classification uses startup intrinsics", async () => {
  const NativePromise = Promise;
  const key = Symbol.hasInstance;
  const descriptor = Object.getOwnPropertyDescriptor(NativePromise, key);
  const reason = new Error("startup promise");
  let reads = 0;
  let result: unknown;
  try {
    Object.defineProperty(globalThis, "Promise", { value: class Replacement {}, configurable: true, writable: true });
    Object.defineProperty(NativePromise, key, { configurable: true, get() { reads++; throw new Error("public hasInstance"); } });
    result = expect(() => NativePromise.reject(reason)).toThrow(reason);
  } finally {
    globalThis.Promise = NativePromise;
    if (descriptor) Object.defineProperty(NativePromise, key, descriptor);
    else Reflect.deleteProperty(NativePromise, key);
  }
  await result;
  assert.equal(reads, 0);
});
