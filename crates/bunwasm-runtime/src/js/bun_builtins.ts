(function (internal: BunWasm.Internal) {
  "use strict";
  const { Array, Error, Function, Map, Object, Proxy, RangeError, Reflect, Set, String, Symbol, TypeError, URIError } = internal.bunBuiltinGlobals;
  const native = internal.native;
  const names = native.bunBuiltinNames();
  const cache = new Map<number, unknown>();
  const loading = new Set<number>();
  const privateNames = new Map<string, symbol>();
  const apply = Reflect.apply;
  const call = Function.prototype.call;
  const functionApply = Function.prototype.apply;
  const bind = Function.prototype.bind;
  const defineProperty = Object.defineProperty;

  function unsupported(what: string) {
    const error: Error & { code?: string } = new Error(`Bun builtin ${what} is not implemented in bun-wasm`);
    error.code = "ERR_BUN_BUILTIN_UNSUPPORTED";
    return error;
  }

  function privateName(name: string) {
    if (!privateNames.has(name)) privateNames.set(name, Symbol(name));
    return privateNames.get(name)!;
  }

  function requireBuiltin(id: string | number): unknown {
    if (typeof id === "string") id = names.indexOf(id);
    if (cache.has(id)) return cache.get(id);
    const name = names[id];
    if (!name) throw unsupported(`module ${id}`);
    if (loading.has(id)) throw unsupported(`circular initialization of ${name}`);
    const source = native.bunBuiltinSource(id);
    if (source === undefined) {
      if (name === "bun" || name.startsWith("node:") || name.startsWith("bun:")) return internal.builtin(name);
      throw unsupported(`module ${name}`);
    }
    const factory = native.evalScript(source, `bun-builtin:${name}`);
    loading.add(id);
    try {
      const exports = factory(intrinsics);
      cache.set(id, exports);
      return exports;
    } finally {
      loading.delete(id);
    }
  }

  const hooks: Record<PropertyKey, unknown> = {
    undefined,
    processBindingConstants: {
      get fs() { return internal.require("node_fs").fs.constants; },
    },
    getPrototypeOf: Object.getPrototypeOf,
    setPrototypeOf: Object.setPrototypeOf,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    isCallable: (value: unknown) => typeof value === "function",
    isObject: (value: unknown) => value !== null && (typeof value === "object" || typeof value === "function"),
    isJSArray: Array.isArray,
    isArray: Array.isArray,
    isPromise: native.isPromise,
    isProxy: native.isProxy,
    isError: native.isError,
    newArrayWithSize: (length: number) => new Array(length),
    getByIdDirect: (object: object, key: PropertyKey) => Object.getOwnPropertyDescriptor(object, key)?.value,
    putByIdDirect(object: object, key: PropertyKey, value: unknown) {
      defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    putByIdDirectPrivate(object: object, key: string, value: unknown) {
      defineProperty(object, privateName(key), { value, writable: true, configurable: true });
      return value;
    },
    getByIdDirectPrivate: (object: Record<symbol, unknown>, key: string) => object[privateName(key)],
    privateName,
    uncurry(fn: (...args: unknown[]) => unknown, operation: string) {
      if (operation === "call") return (...args: unknown[]) => apply(call, fn, args);
      if (operation === "apply") return (...args: unknown[]) => apply(functionApply, fn, args);
      return (...args: unknown[]) => apply(bind, fn, args);
    },
    internalModuleRegistry: cache,
    getInternalField: (registry: Map<number, unknown>, id: number) => registry.get(id),
    createInternalModuleById: requireBuiltin,
    lazy(id: number) {
      const symbol = native.bunBuiltinHookName(id);
      const message = `native hook ${id} (${symbol})`;
      if (!symbol.startsWith("js2native_wrap_")) throw unsupported(message);
      return function () { throw unsupported(message); };
    },
    makeTypeError: (message: string) => new TypeError(message),
    throwTypeError(message: string) { throw new TypeError(message); },
    throwRangeError(message: string) { throw new RangeError(message); },
    makeErrorWithCode(id: number, ..._args: unknown[]) {
      const code = native.bunBuiltinErrorCode(id);
      if (code === "ERR_INVALID_URI") return Object.assign(new URIError("URI malformed"), { code });
      throw unsupported(`error constructor ${code}`);
    },
  };
  Object.assign(hooks, internal.bunBuiltinGlobals);
  const intrinsics = new Proxy(hooks, {
    get(target, name) {
      if (Object.hasOwn(target, name)) return target[name];
      throw unsupported(`intrinsic $${String(name)}`);
    },
  });
  return { require: requireBuiltin };
})
