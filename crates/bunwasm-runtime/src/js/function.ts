(function (internal: BunWasm.Internal) {
  "use strict";
  const { native } = internal;
  if (native.engine === "jsc") return {};
  const global = globalThis;
  const callerSourceOrigin = internal.require("builtins")["bun:jsc"]().callerSourceOrigin;
  const helper = "__bunwasmFunctionImport";
  Object.defineProperty(Function.prototype, helper, {
    value: (from: string) => async (spec: unknown) => {
      const text = `${spec}`;
      if (native.engine === "host") return global.__bunwasm_dynamicImport(from)(text);
      return native.importModule(native.resolve(text, from, false));
    },
  });

  function prepareArguments(args: readonly unknown[], kind: BunWasm.FunctionKind): string[] {
    const strings = Array.from(args, value => `${value}`);
    const origin = callerSourceOrigin();
    const path = origin?.startsWith("file:") ? internal.require("node_url").fileURLToPath(origin) : origin;
    const result = internal.prepareFunctionArgs(strings, kind, path ?? undefined);
    if (native.engine === "host" && result.length > 0 && path) result[result.length - 1] += `\n//# sourceURL=${path}`;
    return result;
  }

  function constructor(Native: Function, kind: BunWasm.FunctionKind) {
    const wrapped = new Proxy(Native, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, prepareArguments(args, kind));
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, prepareArguments(args, kind), newTarget);
      },
    });
    Object.defineProperty(Native.prototype, "constructor", { value: wrapped, configurable: true, writable: true });
    return wrapped;
  }

  internal.defineGlobal("Function", constructor(Function, "normal"));
  constructor(Object.getPrototypeOf(async function () {}).constructor, "async");
  constructor(Object.getPrototypeOf(function* () {}).constructor, "generator");
  constructor(Object.getPrototypeOf(async function* () {}).constructor, "async-generator");
  return {};
})
