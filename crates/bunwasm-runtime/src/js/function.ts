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

  // The host engine has no AsyncContext: give `await` the transpiler's hooks.
  function withAwaitHooks(strings: string[], kind: BunWasm.FunctionKind): string[] {
    if (native.engine !== "host") return strings;
    return native.awaitHooked(strings, kind) || strings;
  }

  function replaceImports(source: string, offsets: number[], replacement: string): string {
    for (const offset of offsets.sort((a, b) => b - a)) {
      source = source.slice(0, offset) + replacement + source.slice(offset + 6);
    }
    return source;
  }

  function argumentsWithImports(Native: Function, args: readonly unknown[], kind: BunWasm.FunctionKind): string[] {
    const strings = Array.from(args, value => `${value}`);
    const hasImports = strings.some(value => value.includes("import"));
    if (!hasImports && native.engine !== "host") return strings;
    // Keep the engine's parameter/body validation and SyntaxError behavior.
    Reflect.apply(Native, undefined, strings);
    const origin = callerSourceOrigin();
    if (origin === null) return withAwaitHooks(strings, kind);
    const path = origin.startsWith("file:") ? internal.require("node_url").fileURLToPath(origin) : origin;
    let result = strings;
    if (hasImports) {
      const offsets = native.functionImports(strings, kind);
      const replacement = `(function(){})[${JSON.stringify(helper)}](${JSON.stringify(path)})`;
      result = strings.map((source, argument) => replaceImports(source, offsets[argument], replacement));
    }
    result = withAwaitHooks(result, kind);
    if (native.engine === "host" && result.length > 0) result[result.length - 1] += `\n//# sourceURL=${path}`;
    return result;
  }

  function constructor(Native: Function, kind: BunWasm.FunctionKind) {
    const wrapped = new Proxy(Native, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, argumentsWithImports(target, args, kind));
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, argumentsWithImports(target, args, kind), newTarget);
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
