(function (internal) {
  "use strict";
  const apply = Reflect.apply;
  const mapHas = Map.prototype.has;
  const setHas = Set.prototype.has;
  const mapGet = Map.prototype.get;
  const probe = {};
  const nativeCaptureStackTrace = Error.captureStackTrace;

  function hasBrand(method, value) {
    try { apply(method, value, [probe]); return true; } catch { return false; }
  }

  function captureStackTrace(target, skip) {
    const nativeCapture = typeof nativeCaptureStackTrace === "function";
    if (nativeCapture) apply(nativeCaptureStackTrace, Error, [target, skip]);
    if (nativeCapture && typeof target.stack !== "string") return;
    const stack = nativeCapture ? target.stack : String(new Error().stack || "");
    const header = target.name + (target.message ? ": " + target.message : "");
    if (stack === header || stack.startsWith(header + "\n")) return;
    let frames = stack.replace(/^(?:Error|Trace)(?::[^\n]*)?(?:\n|$)/, "");
    if (!nativeCapture) frames = frames.split("\n").slice(2).join("\n");
    Object.defineProperty(target, "stack", { value: header + (frames ? "\n" + frames : ""), writable: true, configurable: true });
  }

  function error(Ctor, code, message) {
    return Object.assign(new Ctor(message), { code });
  }

  function validateObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw error(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be an object`);
    }
  }

  const validators = {
    validateObject,
    validateInteger(value, name, min, max) {
      if (typeof value !== "number") throw error(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be a number`);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw error(RangeError, "ERR_OUT_OF_RANGE", `The "${name}" argument must be an integer between ${min} and ${max}`);
      }
    },
    validateArray(value, name) {
      if (!Array.isArray(value)) throw error(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be an Array`);
    },
    validateOneOf(value, name, values) {
      if (!values.includes(value)) throw error(TypeError, "ERR_INVALID_ARG_VALUE", `The "${name}" argument must be one of ${values.join(", ")}`);
    },
  };

  function require(name) {
    if (name === "internal/validators") return validators;
    return internal.builtin(name);
  }

  return {
    require,
    captureStackTrace,
    call: (fn, receiver, ...args) => apply(fn, receiver, args),
    apply: (fn, receiver, args) => apply(fn, receiver, args),
    get: (map, key) => apply(mapGet, map, [key]),
    isMap: value => hasBrand(mapHas, value),
    isSet: value => hasBrand(setHas, value),
    isJSArray: Array.isArray,
    isTypedArrayView: ArrayBuffer.isView,
    newArrayWithSize: length => new Array(length),
    newCppFunction(file, name) {
      if (file === "stringWidth.cpp" && name === "jsFunctionBunStringWidth") return (text, strip) => Bun.stringWidth(text, { ambiguousIsNarrow: true, countAnsiEscapeCodes: strip === false });
      throw new Error(`Unsupported Console native ${file}:${name}`);
    },
    ERR_CONSOLE_WRITABLE_STREAM: message => error(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", message),
    ERR_INCOMPATIBLE_OPTION_PAIR: message => error(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", message),
  };
})
