(function (internal) {
  "use strict";
  const { native } = internal;
  if (native.engine === "jsc") return {};
  const global = globalThis;
  const callerSourceOrigin = internal.require("builtins")["bun:jsc"]().callerSourceOrigin;
  const helper = "__bunwasmFunctionImport";
  Object.defineProperty(Function.prototype, helper, {
    value: from => async spec => {
      const text = `${spec}`;
      if (native.engine === "host") return global.__bunwasm_dynamicImport(from)(text);
      return native.importModule(native.resolve(text, from, false));
    },
  });

  function argumentsWithImports(Native, args, kind) {
    const strings = Array.from(args, value => `${value}`);
    const hasImports = strings.some(value => value.includes("import"));
    if (!hasImports && native.engine !== "host") return strings;
    // Keep the engine's parameter/body validation and SyntaxError behavior.
    Reflect.apply(Native, undefined, strings);
    const origin = callerSourceOrigin();
    if (origin === null) return strings;
    const path = origin.startsWith("file:") ? internal.require("node_url").fileURLToPath(origin) : origin;
    let result = strings;
    if (hasImports) {
      const offsets = native.functionImports(strings, kind);
      const replacement = `(function(){})[${JSON.stringify(helper)}](${JSON.stringify(path)})`;
      result = strings.map((source, argument) => {
        for (const offset of offsets[argument].sort((a, b) => b - a)) {
          source = source.slice(0, offset) + replacement + source.slice(offset + 6);
        }
        return source;
      });
    }
    if (native.engine === "host" && result.length > 0) result[result.length - 1] += `\n//# sourceURL=${path}`;
    return result;
  }

  function constructor(Native, kind) {
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
