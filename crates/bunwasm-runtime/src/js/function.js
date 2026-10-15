(function (internal) {
  "use strict";
  const { native } = internal;
  const callerSourceOrigin = internal.require("builtins")["bun:jsc"]().callerSourceOrigin;

  function argumentsWithImports(args) {
    const strings = Array.from(args, value => `${value}`);
    if (!strings.some(value => value.includes("import"))) return strings;
    const origin = callerSourceOrigin();
    if (origin === null) return strings;
    const path = origin.startsWith("file:") ? internal.require("node_url").fileURLToPath(origin) : origin;
    return strings.map(value => native.rewriteDynamicImports(value, path));
  }

  function constructor(Native) {
    const wrapped = new Proxy(Native, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, argumentsWithImports(args));
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, argumentsWithImports(args), newTarget);
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
