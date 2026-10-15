(function (internal) {
  "use strict";
  const native = internal.native;
  const names = native.bunBuiltinNames();
  const cache = new Map();
  const loading = new Set();
  const privateNames = new Map();
  const apply = Reflect.apply;
  const call = Function.prototype.call;
  const functionApply = Function.prototype.apply;
  const bind = Function.prototype.bind;
  const defineProperty = Object.defineProperty;

  function unsupported(what) {
    const error = new Error(`Bun builtin ${what} is not implemented in bun-wasm`);
    error.code = "ERR_BUN_BUILTIN_UNSUPPORTED";
    return error;
  }

  function privateName(name) {
    if (!privateNames.has(name)) privateNames.set(name, Symbol(name));
    return privateNames.get(name);
  }

  function requireBuiltin(id) {
    if (typeof id === "string") id = names.indexOf(id);
    if (cache.has(id)) return cache.get(id);
    const name = names[id];
    if (!name) throw unsupported(`module ${id}`);
    if (loading.has(id)) throw unsupported(`circular initialization of ${name}`);
    const factory = native.loadBunBuiltin(id);
    if (factory === undefined) {
      if (name.startsWith("node:") || name.startsWith("bun:")) return internal.builtin(name);
      throw unsupported(`module ${name}`);
    }
    loading.add(id);
    try {
      const exports = factory(intrinsics);
      cache.set(id, exports);
      return exports;
    } finally {
      loading.delete(id);
    }
  }

  const hooks = {
    undefined,
    getPrototypeOf: Object.getPrototypeOf,
    setPrototypeOf: Object.setPrototypeOf,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    isCallable: value => typeof value === "function",
    isObject: value => value !== null && (typeof value === "object" || typeof value === "function"),
    isJSArray: Array.isArray,
    isArray: Array.isArray,
    isPromise: native.isPromise,
    isProxy: native.isProxy,
    isError: native.isError,
    newArrayWithSize: length => new Array(length),
    getByIdDirect: (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value,
    putByIdDirect(object, key, value) {
      defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    putByIdDirectPrivate(object, key, value) {
      defineProperty(object, privateName(key), { value, writable: true, configurable: true });
      return value;
    },
    getByIdDirectPrivate: (object, key) => object[privateName(key)],
    privateName,
    uncurry(fn, operation) {
      if (operation === "call") return (...args) => apply(call, fn, args);
      if (operation === "apply") return (...args) => apply(functionApply, fn, args);
      return (...args) => apply(bind, fn, args);
    },
    internalModuleRegistry: cache,
    getInternalField: (registry, id) => registry.get(id),
    createInternalModuleById: requireBuiltin,
    lazy(id) {
      const symbol = native.bunBuiltinHookName(id);
      const message = `native hook ${id} (${symbol})`;
      if (!symbol.startsWith("js2native_wrap_")) throw unsupported(message);
      return function () { throw unsupported(message); };
    },
    makeTypeError: message => new TypeError(message),
    throwTypeError(message) { throw new TypeError(message); },
    throwRangeError(message) { throw new RangeError(message); },
    makeErrorWithCode(id, ...args) {
      const code = native.bunBuiltinErrorCode(id);
      if (code === "ERR_INVALID_URI") return Object.assign(new URIError("URI malformed"), { code });
      throw unsupported(`error constructor ${code}`);
    },
  };
  for (const name of ["Array", "ArrayBuffer", "Buffer", "Infinity", "Promise", "ReadableByteStreamController", "ReadableStream", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableStreamDefaultController", "ReadableStreamDefaultReader", "TransformStream", "TransformStreamDefaultController", "Uint8Array", "String", "RegExp", "WritableStream", "WritableStreamDefaultController", "WritableStreamDefaultWriter", "isFinite"]) {
    Object.defineProperty(hooks, name, { get: () => globalThis[name] });
  }
  const intrinsics = new Proxy(hooks, {
    get(target, name) {
      if (Object.hasOwn(target, name)) return target[name];
      throw unsupported(`intrinsic $${String(name)}`);
    },
  });
  return { require: requireBuiltin };
})
