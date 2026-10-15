(function (internal) {
  "use strict";
  const { native } = internal;
  if (native.engine === "jsc") return {};
  const callerSourceOrigin = internal.require("builtins")["bun:jsc"]().callerSourceOrigin;

  function compiles(Native, args) {
    try {
      Reflect.apply(Native, undefined, args);
      return true;
    } catch {
      return false;
    }
  }

  function selectImports(Native, strings, rewritten, path) {
    const prepare = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = internal.defaultPrepareStackTrace;
      if (!compiles(Native, strings)) return strings;
      if (compiles(Native, rewritten)) return rewritten;
      return strings.map((source, argument) => {
        const selected = [];
        const count = native.dynamicImportCount(source);
        for (let index = 0; index < count; index++) {
          const candidate = strings.slice();
          candidate[argument] = native.rewriteDynamicImports(source, path, [index]);
          if (compiles(Native, candidate)) selected.push(index);
        }
        return native.rewriteDynamicImports(source, path, selected);
      });
    } finally {
      Error.prepareStackTrace = prepare;
    }
  }

  function argumentsWithImports(Native, args) {
    const strings = Array.from(args, value => `${value}`);
    const hasImports = strings.some(value => value.includes("import"));
    if (!hasImports && native.engine !== "host") return strings;
    const origin = callerSourceOrigin();
    if (origin === null) return strings;
    const path = origin.startsWith("file:") ? internal.require("node_url").fileURLToPath(origin) : origin;
    let result = strings;
    if (hasImports) {
      const rewritten = strings.map(value => native.rewriteDynamicImports(value, path));
      if (rewritten.some((value, index) => value !== strings[index])) {
        result = selectImports(Native, strings, rewritten, path);
      }
    }
    if (native.engine === "host" && result.length > 0) {
      result[result.length - 1] += `\n//# sourceURL=${origin}`;
    }
    return result;
  }

  function constructor(Native) {
    const wrapped = new Proxy(Native, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, argumentsWithImports(target, args));
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, argumentsWithImports(target, args), newTarget);
      },
    });
    Object.defineProperty(Native.prototype, "constructor", { value: wrapped, configurable: true, writable: true });
    return wrapped;
  }

  internal.defineGlobal("Function", constructor(Function));
  constructor(Object.getPrototypeOf(async function () {}).constructor);
  constructor(Object.getPrototypeOf(function* () {}).constructor);
  constructor(Object.getPrototypeOf(async function* () {}).constructor);
  if (native.engine !== "host") {
    internal.defineGlobal("__bunwasm_dynamicImport", from => async spec => native.importModule(native.resolve(String(spec), from, false)));
  }
  return {};
})
