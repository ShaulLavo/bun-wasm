(function (internal: {
  nodeCryptoIsKeyObject?(value: object): boolean;
  require(name: "util"): { types: {
    isAnyArrayBuffer(value: unknown): value is ArrayBufferLike;
    isDataView(value: unknown): value is DataView;
    isTypedArray(value: unknown): boolean;
  } };
}) {
  type Cycles = { actual: object[]; expected: object[] };
  type Failure = { actual: unknown; expected: unknown; message: unknown; operator: string; stackStartFn: Function };
  const enumerable = (object: object, key: PropertyKey) => Object.prototype.propertyIsEnumerable.call(object, key);
  const { types } = internal.require("util");
  const typedArrayValues = Uint8Array.prototype.values;
  const typedArrayTag = getter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
  const viewBuffer = getter(DataView.prototype, "buffer");
  const viewOffset = getter(DataView.prototype, "byteOffset");
  const viewLength = getter(DataView.prototype, "byteLength");
  const href = getter(URL.prototype, "href");
  const mapEntries = Map.prototype.entries;
  const setValues = Set.prototype.values;

  function getter(prototype: object, key: PropertyKey) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor?.get) throw new TypeError(`Missing intrinsic getter ${String(key)}`);
    return descriptor.get;
  }

  function properties(actual: object, expected: object, cycles: Cycles, skipIndexes = false): boolean {
    return Reflect.ownKeys(expected).every(key => {
      if (!enumerable(expected, key) || (skipIndexes && typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff)) return true;
      return enumerable(actual, key) && compare(Reflect.get(actual, key), Reflect.get(expected, key), cycles);
    });
  }

  function sequence(actual: readonly unknown[], expected: readonly unknown[], cycles: Cycles): boolean {
    let cursor = 0;
    for (let i = 0; i < expected.length; i++) {
      const last = actual.length - expected.length + i;
      while (cursor <= last && !compare(actual[cursor], expected[i], cycles)) cursor++;
      if (cursor > last) return false;
      cursor++;
    }
    return true;
  }

  function unordered(actual: unknown[], expected: unknown[], equal: (a: unknown, b: unknown) => boolean): boolean {
    const used = new Set<number>();
    return expected.every(value => {
      const index = actual.findIndex((candidate, i) => !used.has(i) && equal(candidate, value));
      if (index < 0) return false;
      used.add(index);
      return true;
    });
  }

  function bufferLike(value: object): value is ArrayBufferLike | ArrayBufferView {
    return types.isAnyArrayBuffer(value) || ArrayBuffer.isView(value);
  }

  function buffers(value: ArrayBufferLike | ArrayBufferView): unknown[] {
    if (!ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value));
    if (types.isDataView(value)) return Array.from(new Uint8Array(viewBuffer.call(value), viewOffset.call(value), viewLength.call(value)));
    return Array.from(Reflect.apply(typedArrayValues, value, []));
  }

  function bufferKind(value: ArrayBufferLike | ArrayBufferView): unknown {
    if (ArrayBuffer.isView(value)) return typedArrayTag.call(value);
    return Object.prototype.toString.call(value);
  }

  function maps(actual: Map<unknown, unknown>, expected: Map<unknown, unknown>, cycles: Cycles): boolean {
    const candidates = Array.from(mapEntries.call(actual));
    const used = new Set<number>();
    for (const [key, value] of mapEntries.call(expected)) {
      let index = candidates.findIndex(([candidate, item], i) => !used.has(i) && (candidate === key || Object.is(candidate, key)) && compare(item, value, cycles));
      if (index < 0 && key !== null && (typeof key === "object" || typeof key === "function")) {
        index = candidates.findIndex(([candidate, item], i) => !used.has(i) && compare(candidate, key, cycles) && compare(item, value, cycles));
      }
      if (index < 0) return false;
      used.add(index);
    }
    return true;
  }

  function urlHref(value: object): unknown {
    try { return href.call(value); } catch { return undefined; }
  }

  function keys(actual: object, expected: object, cycles: Cycles): boolean {
    if (!internal.nodeCryptoIsKeyObject?.(actual) || !internal.nodeCryptoIsKeyObject(expected)) return false;
    const equals: unknown = Reflect.get(actual, "equals");
    return typeof equals === "function" && !!equals.call(actual, expected) && properties(actual, expected, cycles);
  }

  function errors(actual: Error, expected: Error, cycles: Cycles): boolean {
    for (const key of ["name", "message", "errors"]) {
      const value: unknown = Reflect.get(expected, key);
      if (value === undefined || (key === "message" && value === "")) continue;
      if (!compare(Reflect.get(actual, key), value, cycles)) return false;
    }
    if (Object.hasOwn(expected, "cause") && (!Object.hasOwn(actual, "cause") || !compare(actual.cause, expected.cause, cycles))) return false;
    return properties(actual, expected, cycles);
  }

  function primitiveSlot(value: object, tag: string): unknown {
    switch (tag) {
      case "[object Number]": return Number.prototype.valueOf.call(value);
      case "[object String]": return String.prototype.valueOf.call(value);
      case "[object Boolean]": return Boolean.prototype.valueOf.call(value);
      case "[object BigInt]": return BigInt.prototype.valueOf.call(value);
      case "[object Symbol]": return Symbol.prototype.valueOf.call(value);
      default: return value;
    }
  }

  function contents(actual: object, expected: object, cycles: Cycles): boolean {
    if (Array.isArray(actual) && Array.isArray(expected)) {
      return sequence(actual, expected, cycles) && properties(actual, expected, cycles, true);
    }
    if (actual instanceof Map && expected instanceof Map) {
      return maps(actual, expected, cycles) && properties(actual, expected, cycles);
    }
    if (actual instanceof Set && expected instanceof Set) {
      return unordered(Array.from(setValues.call(actual)), Array.from(setValues.call(expected)), (a, b) => compare(a, b, cycles)) && properties(actual, expected, cycles);
    }
    if (bufferLike(actual) || bufferLike(expected)) {
      if (!bufferLike(actual) || !bufferLike(expected)) return false;
      if (bufferKind(actual) !== bufferKind(expected)) return false;
      return sequence(buffers(actual), buffers(expected), cycles) && properties(actual, expected, cycles, types.isTypedArray(expected));
    }
    if (internal.nodeCryptoIsKeyObject?.(actual) || internal.nodeCryptoIsKeyObject?.(expected)) return keys(actual, expected, cycles);
    const actualHref = urlHref(actual), expectedHref = urlHref(expected);
    if (actualHref !== undefined || expectedHref !== undefined) return actualHref === expectedHref && properties(actual, expected, cycles);
    if (actual instanceof Error && expected instanceof Error) return errors(actual, expected, cycles);
    if (actual instanceof Date && expected instanceof Date) return Object.is(actual.getTime(), expected.getTime()) && properties(actual, expected, cycles);
    if (actual instanceof RegExp && expected instanceof RegExp) {
      return actual.source === expected.source && actual.flags === expected.flags && Object.is(actual.lastIndex, expected.lastIndex) && properties(actual, expected, cycles);
    }
    const tag = Object.prototype.toString.call(expected);
    if (Object.prototype.toString.call(actual) !== tag) return false;
    const expectedValue = primitiveSlot(expected, tag);
    if (expectedValue !== expected && !Object.is(primitiveSlot(actual, tag), expectedValue)) return false;
    return properties(actual, expected, cycles);
  }

  function compare(actual: unknown, expected: unknown, cycles: Cycles): boolean {
    if (Object.is(actual, expected)) return true;
    if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return false;
    if (actual instanceof WeakMap || actual instanceof WeakSet || actual instanceof Promise || expected instanceof WeakMap || expected instanceof WeakSet || expected instanceof Promise) return false;
    const seenActual = cycles.actual.includes(actual), seenExpected = cycles.expected.includes(expected);
    if (seenActual || seenExpected) return seenActual && seenExpected;
    cycles.actual.push(actual);
    cycles.expected.push(expected);
    try {
      return contents(actual, expected, cycles);
    } finally {
      cycles.actual.pop();
      cycles.expected.pop();
    }
  }

  function create(innerFail: (failure: Failure) => never, requireArgs: (length: number, required: number) => void) {
    return function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: unknown) {
      requireArgs(arguments.length, 2);
      if (compare(actual, expected, { actual: [], expected: [] })) return;
      innerFail({ actual, expected, message, operator: "partialDeepStrictEqual", stackStartFn: partialDeepStrictEqual });
    };
  }

  return { create };
})
