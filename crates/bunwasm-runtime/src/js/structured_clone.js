// structuredClone in JS (HTML structured clone algorithm, matching Bun where
// observable). Preserves cycles and shared references, including several views
// over one ArrayBuffer. Class instances become plain objects. Functions,
// symbols, promises, weak collections, iterators and similar host objects
// throw a DataCloneError.
(function (internal) {
  "use strict";

  const objectToString = Object.prototype.toString;
  const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayTag = Object.getOwnPropertyDescriptor(TypedArrayProto, Symbol.toStringTag).get;

  // Built-in objects with internal state that the algorithm refuses to clone.
  const kUncloneableTags = new Set([
    "Arguments",
    "Math",
    "JSON",
    "Reflect",
    "Atomics",
    "Promise",
    "WeakMap",
    "WeakSet",
    "WeakRef",
    "FinalizationRegistry",
    "Generator",
    "AsyncGenerator",
    "Map Iterator",
    "Set Iterator",
    "Array Iterator",
    "String Iterator",
    "RegExp String Iterator",
    "Iterator Helper",
    "EventTarget",
    "AbortSignal",
    "AbortController",
  ]);

  const kErrorNames = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"];

  function dataCloneError(message) {
    const text = message || "The object can not be cloned.";
    if (typeof DOMException === "function") return new DOMException(text, "DataCloneError");
    const err = new Error(text);
    err.name = "DataCloneError";
    err.code = 25;
    return err;
  }

  function brand(method, value, args) {
    if (typeof method !== "function") return false;
    try {
      method.apply(value, args || []);
      return true;
    } catch (_) {
      return false;
    }
  }

  const getter = (proto, key) => {
    const desc = proto && Object.getOwnPropertyDescriptor(proto, key);
    return desc ? desc.get : undefined;
  };
  const abByteLength = getter(ArrayBuffer.prototype, "byteLength");
  const sabByteLength = typeof SharedArrayBuffer === "function" ? getter(SharedArrayBuffer.prototype, "byteLength") : undefined;
  const mapSize = getter(Map.prototype, "size");
  const setSize = getter(Set.prototype, "size");
  const dvBuffer = getter(DataView.prototype, "buffer");
  const regexpSource = getter(RegExp.prototype, "source");

  const isArrayBuffer = (v) => brand(abByteLength, v);
  const isSharedArrayBuffer = (v) => brand(sabByteLength, v);
  const isDataView = (v) => brand(dvBuffer, v);
  const isTypedArray = (v) => typedArrayTag.call(v) !== undefined;

  function isUncloneable(value) {
    if (typeof internal.isProxy === "function" && internal.isProxy(value) && !internal.isProcessEnv?.(value)) return true;
    if (value instanceof Promise || brand(WeakMap.prototype.has, value, [{}]) || brand(WeakSet.prototype.has, value, [{}])) {
      return true;
    }
    if (typeof WeakRef === "function" && brand(WeakRef.prototype.deref, value)) return true;
    if (typeof EventTarget === "function" && value instanceof EventTarget) return true;
    return kUncloneableTags.has(objectToString.call(value).slice(8, -1));
  }

  function errorConstructorFor(value) {
    const name = value.name;
    const index = kErrorNames.indexOf(typeof name === "string" ? name : "");
    return globalThis[kErrorNames[index === -1 ? 0 : index]];
  }

  function hasOwnData(obj, key) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc !== undefined && "value" in desc;
  }

  class Cloner {
    constructor() {
      this.memory = new Map();
    }

    clone(value) {
      if (typeof value === "symbol" || typeof value === "function") throw dataCloneError();
      if (value === null || typeof value !== "object") return value;
      const known = this.memory.get(value);
      if (known !== undefined) return known;
      return this.cloneObject(value);
    }

    remember(original, copy) {
      this.memory.set(original, copy);
      return copy;
    }

    cloneBoxed(value) {
      if (brand(Number.prototype.valueOf, value)) return Object(Number.prototype.valueOf.call(value));
      if (brand(String.prototype.valueOf, value)) return Object(String.prototype.valueOf.call(value));
      if (brand(Boolean.prototype.valueOf, value)) return Object(Boolean.prototype.valueOf.call(value));
      if (typeof BigInt === "function" && brand(BigInt.prototype.valueOf, value)) {
        return Object(BigInt.prototype.valueOf.call(value));
      }
      if (brand(Symbol.prototype.valueOf, value)) throw dataCloneError();
      return undefined;
    }

    cloneArrayBuffer(value) {
      const copy = value.resizable ? new ArrayBuffer(value.byteLength, { maxByteLength: value.maxByteLength }) : new ArrayBuffer(value.byteLength);
      new Uint8Array(copy).set(new Uint8Array(value));
      return copy;
    }

    cloneView(value) {
      const buffer = this.clone(value.buffer);
      if (isDataView(value)) return new DataView(buffer, value.byteOffset, value.byteLength);
      // Buffer and other subclasses clone to their intrinsic typed array type.
      const Ctor = globalThis[typedArrayTag.call(value)];
      return new Ctor(buffer, value.byteOffset, value.length);
    }

    cloneError(value) {
      const Ctor = errorConstructorFor(value);
      const copy = hasOwnData(value, "message") ? new Ctor(String(value.message)) : new Ctor();
      if (!hasOwnData(value, "message")) delete copy.message;
      if (hasOwnData(value, "stack") && typeof value.stack === "string") {
        Object.defineProperty(copy, "stack", { value: value.stack, writable: true, configurable: true, enumerable: false });
      }
      return copy;
    }

    cloneSpecial(value) {
      const boxed = this.cloneBoxed(value);
      if (boxed !== undefined) return boxed;
      if (brand(Date.prototype.getTime, value)) return new Date(Date.prototype.getTime.call(value));
      if (value !== RegExp.prototype && brand(regexpSource, value)) return new RegExp(value.source, value.flags);
      if (isArrayBuffer(value)) return this.cloneArrayBuffer(value);
      if (isSharedArrayBuffer(value)) return value;
      if (isTypedArray(value) || isDataView(value)) return this.cloneView(value);
      if (value instanceof Error || objectToString.call(value) === "[object Error]") return this.cloneError(value);
      return undefined;
    }

    cloneObject(value) {
      const special = this.cloneSpecial(value);
      if (special !== undefined) return this.remember(value, special);
      if (brand(mapSize, value)) return this.cloneMap(value);
      if (brand(setSize, value)) return this.cloneSet(value);
      if (Array.isArray(value)) return this.cloneProperties(value, this.remember(value, new Array(value.length)));
      if (isUncloneable(value)) throw dataCloneError();
      return this.cloneProperties(value, this.remember(value, {}));
    }

    cloneMap(value) {
      const copy = this.remember(value, new Map());
      // Snapshot entries first: cloning may run getters that mutate the map.
      for (const [k, v] of Array.from(value)) copy.set(this.clone(k), this.clone(v));
      return copy;
    }

    cloneSet(value) {
      const copy = this.remember(value, new Set());
      for (const v of Array.from(value)) copy.add(this.clone(v));
      return copy;
    }

    // Own enumerable string keys only (holes in arrays stay holes).
    cloneProperties(value, copy) {
      for (const key of Object.keys(value)) {
        Object.defineProperty(copy, key, {
          value: this.clone(value[key]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return copy;
    }
  }

  // Validates the transfer list; returns the ArrayBuffers to detach.
  function transferList(options) {
    if (options === undefined || options === null) return [];
    const transfer = options.transfer;
    if (transfer === undefined) return [];
    if (transfer === null || typeof transfer[Symbol.iterator] !== "function") {
      const err = new TypeError("Optional options.transfer argument must be an iterable");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const buffers = Array.from(transfer);
    const seen = new Set();
    for (const item of buffers) {
      if (internal.isMarkedAsUntransferable && internal.isMarkedAsUntransferable(item)) throw dataCloneError("Object is not transferable");
      if (!isArrayBuffer(item) && !(internal.isMessagePort && internal.isMessagePort(item))) throw new TypeError("Type error");
      if (seen.has(item)) throw dataCloneError("Transfer list contains duplicate ArrayBuffer");
      seen.add(item);
    }
    return buffers;
  }

  function structuredClone(value, options) {
    if (arguments.length === 0) throw new TypeError("structuredClone requires 1 argument");
    const buffers = transferList(options);
    if (internal.clonePorts && buffers.some((item) => internal.isMessagePort(item))) return internal.clonePorts(value, { transfer: buffers });
    const result = new Cloner().clone(value);
    for (const buffer of buffers) if (internal.isWasmMemoryBuffer?.(buffer)) throw dataCloneError("WebAssembly memory is not transferable");
    try { internal.native.transferArrayBuffers(buffers); }
    catch { throw dataCloneError("ArrayBuffer is not detachable"); }
    return result;
  }

  return { structuredClone };
});
