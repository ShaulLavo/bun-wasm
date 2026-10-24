(function (internal: BunWasm.Internal): BunWasm.ConsoleIntrinsics {
  "use strict";
  const apply = Reflect.apply;
  const mapHas = Map.prototype.has;
  const setHas = Set.prototype.has;
  const mapGet = Map.prototype.get;
  const probe = {};
  const nativeCaptureStackTrace = Error.captureStackTrace;

  function hasBrand(method: (key: object) => boolean, value: unknown) {
    try { apply(method, value, [probe]); return true; } catch { return false; }
  }

  function captureStackTrace(target: BunWasm.ConsoleTrace, skip?: BunWasm.ConsoleFunction) {
    const nativeCapture = typeof nativeCaptureStackTrace === "function";
    if (nativeCapture) apply(nativeCaptureStackTrace, Error, [target, skip]);
    if (nativeCapture && (typeof target.stack !== "string" || typeof Error.prepareStackTrace === "function" && Error.prepareStackTrace !== internal.defaultPrepareStackTrace)) return;
    const stack = nativeCapture ? target.stack as string : String(new Error().stack || "");
    const header = target.name + (target.message ? ": " + target.message : "");
    if (stack === header || stack.startsWith(header + "\n")) return;
    let frames = stack.replace(/^(?:Error|Trace)(?::[^\n]*)?(?:\n|$)/, "");
    if (!nativeCapture) frames = frames.split("\n").slice(2).join("\n");
    Object.defineProperty(target, "stack", { value: header + (frames ? "\n" + frames : ""), writable: true, configurable: true });
  }

  function error(Ctor: new(message?: string) => Error, code: string, message: string) {
    return Object.assign(new Ctor(message), { code });
  }

  function validateObject(value: unknown, name: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw error(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be an object`);
    }
  }

  const validators = {
    validateObject,
    validateInteger(value: unknown, name: string, min: number, max: number) {
      if (typeof value !== "number") throw error(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be a number`);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw error(RangeError, "ERR_OUT_OF_RANGE", `The "${name}" argument must be an integer between ${min} and ${max}`);
      }
    },
    validateArray(value: unknown, name: string) {
      if (!Array.isArray(value)) throw error(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be an Array`);
    },
    validateOneOf(value: unknown, name: string, values: readonly unknown[]) {
      if (!values.includes(value)) throw error(TypeError, "ERR_INVALID_ARG_VALUE", `The "${name}" argument must be one of ${values.join(", ")}`);
    },
  };

  function require(name: "internal/validators"): typeof validators;
  function require<K extends keyof BunWasm.ConsoleBuiltins>(name: K): BunWasm.ConsoleBuiltins[K];
  function require(name: keyof BunWasm.ConsoleBuiltins | "internal/validators") {
    if (name === "internal/validators") return validators;
    return internal.builtin(name);
  }

  return {
    require,
    captureStackTrace,
    call: <This, Args extends unknown[], Result>(fn: (this: This, ...args: Args) => Result, receiver: This, ...args: Args): Result => apply(fn, receiver, args),
    apply: <This, Args extends unknown[], Result>(fn: (this: This, ...args: Args) => Result, receiver: This, args: Args): Result => apply(fn, receiver, args),
    get: <Key, Value>(map: Map<Key, Value>, key: Key): Value | undefined => apply(mapGet, map, [key]),
    isMap: value => hasBrand(mapHas, value),
    isSet: value => hasBrand(setHas, value),
    isJSArray: Array.isArray,
    isTypedArrayView: ArrayBuffer.isView,
    newArrayWithSize: length => new Array<never>(length),
    newCppFunction(file: string, name: string) {
      if (file === "stringWidth.cpp" && name === "jsFunctionBunStringWidth") return (text: string, strip?: boolean) => Bun.stringWidth(text, { ambiguousIsNarrow: true, countAnsiEscapeCodes: strip === false });
      throw new Error(`Unsupported Console native ${file}:${name}`);
    },
    ERR_CONSOLE_WRITABLE_STREAM: message => error(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", message),
    ERR_INCOMPATIBLE_OPTION_PAIR: message => error(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", message),
  };
})
