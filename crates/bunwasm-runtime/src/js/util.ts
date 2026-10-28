// node:util polyfill. Formatting (inspect/format) is delegated lazily to the
// "inspect" polyfill. Also exports two non-standard helpers used by other
// polyfills: `_deepEqual` (Node's isDeepStrictEqual / deepStrictEqual
// semantics) and `bunDeepEquals` (Bun.deepEquals semantics).
(function (internal: BunWasm.Internal) {
  "use strict";

  const kCustomInspect = Symbol.for("nodejs.util.inspect.custom");
  const kCustomPromisify = Symbol.for("nodejs.util.promisify.custom");
  // Functions tagged with an array of names resolve promisified calls with an object.
  const kCustomPromisifyArgs = Symbol.for("nodejs.util.promisify.customArgs");

  function inspectModule() {
    return internal.require("inspect");
  }

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  function makeError(Ctor: new(message?: string) => BunWasm.UtilityError, code: string, message: string) {
    const err = new Ctor(message);
    err.code = code;
    return err;
  }

  function describeReceived(value: unknown) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") {
      if (value.constructor && value.constructor.name) return `an instance of ${value.constructor.name}`;
      return inspect(value, { depth: -1 });
    }
    if (typeof value === "string") {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return `type string (${shown.indexOf("'") === -1 ? `'${shown}'` : JSON.stringify(shown)})`;
    }
    if (typeof value === "bigint") return `type bigint (${value}n)`;
    if (typeof value === "number" && Object.is(value, -0)) return "type number (-0)";
    return `type ${typeof value} (${String(value)})`;
  }

  function invalidArgType(name: string, expected: string, value: unknown) {
    const kind = name.includes(".") ? "property" : "argument";
    const subject = name.endsWith(" argument") ? `The ${name}` : `The "${name}" ${kind}`;
    return makeError(TypeError, "ERR_INVALID_ARG_TYPE", `${subject} must be ${expected}. Received ${describeReceived(value)}`);
  }

  function validateFunction(value: unknown, name: string): asserts value is BunWasm.UtilityFunction {
    if (typeof value !== "function") throw invalidArgType(name, "of type function", value);
  }

  function validateString(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
  }

  function validateObject(value: unknown, name: string): asserts value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw invalidArgType(name, "of type object", value);
    }
  }

  // ---------------------------------------------------------------------------
  // inspect / format (delegated)
  // ---------------------------------------------------------------------------

  const localDefaultOptions = {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3,
    sorted: false,
    getters: false,
    numericSeparator: false,
  };

  function inspect(value: unknown, opts?: BunWasm.InspectOptions | boolean) {
    let options = opts;
    // Legacy signature: inspect(obj, showHidden, depth, colors).
    if (typeof opts !== "object" || opts === null) {
      options = {};
      if (arguments.length > 1 && opts !== undefined) options.showHidden = opts;
      if (arguments.length > 2 && arguments[2] !== undefined) options.depth = arguments[2];
      if (arguments.length > 3 && arguments[3] !== undefined) options.colors = arguments[3];
    }
    return inspectModule().nodeInspect(value, options as BunWasm.InspectOptions);
  }

  // Forwards to the inspect module's own tables when it provides them.
  function forwardProperty<K extends "defaultOptions" | "colors" | "styles">(name: K, fallback: NonNullable<BunWasm.InspectFunction[K]>) {
    let local = fallback;
    Object.defineProperty(inspect, name, {
      enumerable: true,
      configurable: true,
      get() {
        const mod = inspectModule();
        const shared = mod.nodeInspect && mod.nodeInspect[name];
        return shared !== undefined ? shared : local;
      },
      set(value: NonNullable<BunWasm.InspectFunction[K]>) {
        const mod = inspectModule();
        if (name === "defaultOptions") validateObject(value, "options");
        if (mod.nodeInspect && mod.nodeInspect[name] !== undefined) {
          if (name === "defaultOptions") Object.assign(mod.nodeInspect[name], value);
          else mod.nodeInspect[name] = value;
          return;
        }
        local = name === "defaultOptions" ? Object.assign(local, value) : value;
      },
    });
  }

  const ansiColors: Record<string, number[]> = {
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    blink: [5, 25],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    doubleunderline: [21, 24],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    framed: [51, 54],
    overlined: [53, 55],
    gray: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
    bgGray: [100, 49],
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49],
  };
  const colorAliases: Record<string, string> = {
    grey: "gray",
    blackBright: "gray",
    bgGrey: "bgGray",
    bgBlackBright: "bgGray",
    dim: "faint",
    strikethrough: "crossedout",
    strikeThrough: "crossedout",
    crossedOut: "crossedout",
    hidden: "conceal",
    inverse: "swapColors",
    swapcolors: "swapColors",
    doubleUnderline: "doubleunderline",
  };
  // Node defines aliases as both "alias -> target" and "target -> alias" pairs.
  for (const alias of Object.keys(colorAliases)) {
    const target = colorAliases[alias];
    if (ansiColors[alias] && !ansiColors[target]) ansiColors[target] = ansiColors[alias];
    else if (ansiColors[target] && !ansiColors[alias]) ansiColors[alias] = ansiColors[target];
  }

  const defaultStyles = {
    special: "cyan",
    number: "yellow",
    bigint: "yellow",
    boolean: "yellow",
    undefined: "grey",
    null: "bold",
    string: "green",
    symbol: "green",
    date: "magenta",
    regexp: "red",
    module: "underline",
  };

  inspect.custom = kCustomInspect;
  forwardProperty("defaultOptions", localDefaultOptions);
  forwardProperty("colors", ansiColors);
  forwardProperty("styles", defaultStyles);

  function format() {
    const mod = inspectModule();
    return mod.nodeFormat.apply(null, arguments);
  }

  function formatWithOptions(inspectOptions: unknown) {
    validateObject(inspectOptions, "inspectOptions");
    const mod = inspectModule();
    return mod.nodeFormatWithOptions.apply(null, arguments);
  }

  // ---------------------------------------------------------------------------
  // promisify / callbackify / inherits / deprecate
  // ---------------------------------------------------------------------------

  function promisify(original: unknown) {
    validateFunction(original, "original");
    if (original[kCustomPromisify]) {
      const fn = original[kCustomPromisify];
      validateFunction(fn, "util.promisify.custom");
      return Object.defineProperty(fn, kCustomPromisify, { value: fn, enumerable: false, writable: false, configurable: true });
    }
    const argumentNames = original[kCustomPromisifyArgs] as string[] | undefined;

    function fn(this: unknown) {
      const args: unknown[] = Array.prototype.slice.call(arguments);
      return new Promise<unknown>((resolve, reject) => {
        const callback = function (err: unknown) {
          if (err) {
            reject(err);
            return;
          }
          const values: unknown[] = Array.prototype.slice.call(arguments, 1);
          resolve(argumentNames === undefined ? values[0] : namedValues(argumentNames, values));
        };
        Reflect.apply(original as BunWasm.UtilityFunction, this, args.concat([callback]));
      });
    }

    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisify, { value: fn, enumerable: false, writable: false, configurable: true });
    const descriptors = Object.getOwnPropertyDescriptors(original);
    for (const key of Reflect.ownKeys(descriptors)) {
      Object.defineProperty(fn, key, descriptors[key]);
    }
    return fn;
  }
  promisify.custom = kCustomPromisify;

  function namedValues(names: string[], values: unknown[]) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) obj[names[i]] = values[i];
    return obj;
  }

  function nextTick(fn: BunWasm.UtilityFunction, a: unknown, b?: unknown) {
    if (typeof process !== "undefined" && typeof process.nextTick === "function") {
      process.nextTick(fn, a, b);
      return;
    }
    queueMicrotask(() => fn(a, b));
  }

  function falsyRejection(reason: unknown) {
    const err = makeError(Error, "ERR_FALSY_VALUE_REJECTION", "Promise was rejected with a falsy value");
    err.reason = reason;
    return err;
  }

  function callbackify(original: unknown) {
    validateFunction(original, "original");
    function callbackified(this: unknown) {
      const args: unknown[] = Array.prototype.slice.call(arguments);
      const maybeCb = args.pop();
      validateFunction(maybeCb, "last argument");
      const cb = maybeCb.bind(this);
      (Reflect.apply(original as BunWasm.UtilityFunction, this, args) as PromiseLike<unknown>).then(
        (ret: unknown) => nextTick(cb, null, ret),
        (rej: unknown) => nextTick(cb, rej ? rej : falsyRejection(rej)),
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(original);
    if (typeof descriptors.length.value === "number") descriptors.length.value++;
    if (typeof descriptors.name.value === "string") descriptors.name.value += "Callbackified";
    const propertiesValues = Object.values(descriptors);
    for (const descriptor of propertiesValues) Object.setPrototypeOf(descriptor, null);
    Object.defineProperties(callbackified, descriptors);
    return callbackified;
  }

  function inherits(ctor: { prototype: object } | null | undefined, superCtor: { prototype?: object } | null | undefined) {
    if (ctor === undefined || ctor === null) throw invalidArgType("ctor", "of type function", ctor);
    if (superCtor === undefined || superCtor === null) throw invalidArgType("superCtor", "of type function", superCtor);
    if (superCtor.prototype === undefined) {
      throw invalidArgType("superCtor.prototype", "of type object", superCtor.prototype);
    }
    Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }

  const warnedCodes = new Set<string>();

  function emitDeprecation(msg: string, code?: string) {
    const proc = typeof process !== "undefined" ? process : undefined;
    if (proc && proc.noDeprecation) return;
    if (proc && typeof proc.emitWarning === "function") {
      proc.emitWarning(msg, "DeprecationWarning", code);
      return;
    }
    if (proc && proc.throwDeprecation) {
      const err: BunWasm.UtilityError = new Error(msg);
      err.name = "DeprecationWarning";
      if (code) err.code = code;
      throw err;
    }
    const pid = proc && proc.pid !== undefined ? proc.pid : 0;
    console.error(`(node:${pid}) ${code ? `[${code}] ` : ""}DeprecationWarning: ${msg}`);
  }

  function deprecate(fn: unknown, msg: string, code?: string) {
    validateFunction(fn, "fn");
    if (code !== undefined) validateString(code, "code");
    let warned = false;
    function deprecated(this: unknown) {
      if (!warned) {
        warned = true;
        const seen = code !== undefined && warnedCodes.has(code);
        if (code !== undefined) warnedCodes.add(code);
        if (!seen) emitDeprecation(msg, code);
      }
      if (new.target) return Reflect.construct(fn as Function, arguments, new.target);
      return Reflect.apply(fn as Function, this, arguments);
    }
    Object.setPrototypeOf(deprecated, fn);
    if (fn.prototype) deprecated.prototype = fn.prototype;
    return deprecated;
  }

  // ---------------------------------------------------------------------------
  // util.types (brand checks via built-in getters where possible)
  // ---------------------------------------------------------------------------

  const objectToString = Object.prototype.toString;
  const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayTag = (Object.getOwnPropertyDescriptor(TypedArrayProto, Symbol.toStringTag) as { get: (this: unknown) => string | undefined }).get;

  function getterOf(proto: object | undefined, key: PropertyKey) {
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, key) : undefined;
    return desc ? desc.get : undefined;
  }

  // True when calling `method` with `value` as receiver does not throw.
  function brandCheck(method: Function | undefined, value: unknown, args?: unknown[]) {
    if (typeof method !== "function" || value === null || typeof value !== "object") return false;
    try {
      method.apply(value, args || []);
      return true;
    } catch (_) {
      return false;
    }
  }

  const mapSize = getterOf(Map.prototype, "size");
  const setSize = getterOf(Set.prototype, "size");
  const abByteLength = getterOf(ArrayBuffer.prototype, "byteLength");
  const sabByteLength = typeof SharedArrayBuffer === "function" ? getterOf(SharedArrayBuffer.prototype, "byteLength") : undefined;
  const dvByteLength = getterOf(DataView.prototype, "byteLength");
  const regexpSource = getterOf(RegExp.prototype, "source");

  function tagOf(value: unknown) {
    return objectToString.call(value).slice(8, -1);
  }

  function typedArrayName(value: unknown): string | undefined {
    return typedArrayTag.call(value);
  }

  function isTypedArray(value: unknown): value is BunWasm.NumericView {
    return typedArrayName(value) !== undefined;
  }

  function isDate(value: unknown): value is Date {
    return brandCheck(Date.prototype.getTime, value);
  }

  function isRegExp(value: unknown): value is RegExp {
    return value !== RegExp.prototype && brandCheck(regexpSource, value);
  }

  function isMap(value: unknown): value is Map<unknown, unknown> {
    return brandCheck(mapSize, value);
  }

  function isSet(value: unknown): value is Set<unknown> {
    return brandCheck(setSize, value);
  }

  function isArrayBuffer(value: unknown): value is ArrayBuffer {
    return brandCheck(abByteLength, value);
  }

  function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    return brandCheck(sabByteLength, value);
  }

  function isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
    return isArrayBuffer(value) || isSharedArrayBuffer(value);
  }

  function isNumberObject(value: unknown): value is BunWasm.BoxedPrimitive<number> {
    return brandCheck(Number.prototype.valueOf, value);
  }

  function isStringObject(value: unknown): value is BunWasm.BoxedPrimitive<string> {
    return brandCheck(String.prototype.valueOf, value);
  }

  function isBooleanObject(value: unknown): value is BunWasm.BoxedPrimitive<boolean> {
    return brandCheck(Boolean.prototype.valueOf, value);
  }

  function isBigIntObject(value: unknown): value is BunWasm.BoxedPrimitive<bigint> {
    return typeof BigInt === "function" && brandCheck(BigInt.prototype.valueOf, value);
  }

  function isSymbolObject(value: unknown): value is BunWasm.BoxedPrimitive<symbol> {
    return brandCheck(Symbol.prototype.valueOf, value);
  }

  function isBoxedPrimitive(value: unknown): value is BunWasm.BoxedPrimitive<number | string | boolean | bigint | symbol> {
    return (
      isNumberObject(value) ||
      isStringObject(value) ||
      isBooleanObject(value) ||
      isBigIntObject(value) ||
      isSymbolObject(value)
    );
  }

  function isPromise(value: unknown): value is Promise<unknown> {
    if (typeof internal.isPromise === "function") return internal.isPromise(value);
    return value instanceof Promise;
  }

  function isNativeError(value: unknown): value is Error {
    if (typeof internal.isError === "function") return internal.isError(value);
    if (typeof Error.isError === "function") return Error.isError(value);
    return value instanceof Error;
  }

  function isProxy(value: unknown) {
    return typeof internal.isProxy === "function" ? internal.isProxy(value) : false;
  }

  function isModuleNamespaceObject(value: unknown) {
    if (typeof internal.isModuleNamespaceObject === "function") return internal.isModuleNamespaceObject(value);
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== null) return false;
    const desc = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
    return desc !== undefined && desc.value === "Module" && !desc.writable && !desc.configurable;
  }

  function isFunctionWithTag(value: unknown, tags: string[]) {
    return typeof value === "function" && tags.includes(tagOf(value));
  }

  function typedArrayCheck(name: string) {
    return (value: unknown) => typedArrayName(value) === name;
  }

  const types = {
    isExternal: () => false,
    isDate,
    isArgumentsObject: (value: unknown) => value !== null && typeof value === "object" && tagOf(value) === "Arguments",
    isBigIntObject,
    isBooleanObject,
    isNumberObject,
    isStringObject,
    isSymbolObject,
    isBoxedPrimitive,
    isNativeError,
    isRegExp,
    isAsyncFunction: (value: unknown) => isFunctionWithTag(value, ["AsyncFunction", "AsyncGeneratorFunction"]),
    isGeneratorFunction: (value: unknown) => isFunctionWithTag(value, ["GeneratorFunction", "AsyncGeneratorFunction"]),
    isGeneratorObject: (value: unknown) =>
      value !== null && typeof value === "object" && ["Generator", "AsyncGenerator"].includes(tagOf(value)),
    isPromise,
    isMap,
    isSet,
    isMapIterator: (value: unknown) => value !== null && typeof value === "object" && tagOf(value) === "Map Iterator",
    isSetIterator: (value: unknown) => value !== null && typeof value === "object" && tagOf(value) === "Set Iterator",
    isWeakMap: (value: unknown) => brandCheck(WeakMap.prototype.has, value, [{}]),
    isWeakSet: (value: unknown) => brandCheck(WeakSet.prototype.has, value, [{}]),
    isArrayBuffer,
    isDataView: (value: unknown) => brandCheck(dvByteLength, value),
    isSharedArrayBuffer,
    isProxy,
    isModuleNamespaceObject,
    isAnyArrayBuffer,
    isCryptoKey: value => internal.crypto.isKey(value),
    isKeyObject: value => { internal.builtin("node:crypto"); return internal.nodeCryptoIsKeyObject(value); },
    isArrayBufferView: (value: unknown) => ArrayBuffer.isView(value),
    isTypedArray,
    isUint8Array: typedArrayCheck("Uint8Array"),
    isUint8ClampedArray: typedArrayCheck("Uint8ClampedArray"),
    isUint16Array: typedArrayCheck("Uint16Array"),
    isUint32Array: typedArrayCheck("Uint32Array"),
    isInt8Array: typedArrayCheck("Int8Array"),
    isInt16Array: typedArrayCheck("Int16Array"),
    isInt32Array: typedArrayCheck("Int32Array"),
    isFloat16Array: typedArrayCheck("Float16Array"),
    isFloat32Array: typedArrayCheck("Float32Array"),
    isFloat64Array: typedArrayCheck("Float64Array"),
    isBigInt64Array: typedArrayCheck("BigInt64Array"),
    isBigUint64Array: typedArrayCheck("BigUint64Array"),
    isEventTarget: (value: unknown) => typeof EventTarget === "function" && value instanceof EventTarget,
  } satisfies Record<string, (value: unknown) => boolean>;

  // ---------------------------------------------------------------------------
  // Node deep equality (isDeepStrictEqual / assert.deepStrictEqual)
  // ---------------------------------------------------------------------------

  const hasOwn = (obj: unknown, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key);
  const isEnumerable = (obj: unknown, key: PropertyKey) => Object.prototype.propertyIsEnumerable.call(obj, key);
  const kNoIterator = 0;
  const kIsArray = 1;
  const kIsSet = 2;
  const kIsMap = 3;

  function isIndexKey(key: PropertyKey) {
    return typeof key === "string" && key !== "" && String(Number(key) >>> 0) === key && Number(key) !== 4294967295;
  }

  // Own enumerable non-index keys (strings, plus symbols when `withSymbols`).
  function nonIndexKeys(obj: object, withSymbols: boolean): (string | symbol)[] {
    const keys: (string | symbol)[] = Object.keys(obj).filter((key) => !isIndexKey(key));
    if (!withSymbols) return keys;
    return keys.concat(Object.getOwnPropertySymbols(obj).filter((sym) => isEnumerable(obj, sym)));
  }

  function bytesOf(view: ArrayBufferView) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  function equalBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function looseEqualElements(a: ArrayLike<unknown>, b: ArrayLike<unknown>) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  function equalBoxed(a: unknown, b: unknown) {
    if (isNumberObject(a)) return isNumberObject(b) && Object.is(Number.prototype.valueOf.call(a), Number.prototype.valueOf.call(b));
    if (isStringObject(a)) return isStringObject(b) && String.prototype.valueOf.call(a) === String.prototype.valueOf.call(b);
    if (isBooleanObject(a)) return isBooleanObject(b) && Boolean.prototype.valueOf.call(a) === Boolean.prototype.valueOf.call(b);
    if (isBigIntObject(a)) return isBigIntObject(b) && BigInt.prototype.valueOf.call(a) === BigInt.prototype.valueOf.call(b);
    if (isSymbolObject(a)) return isSymbolObject(b) && Symbol.prototype.valueOf.call(a) === Symbol.prototype.valueOf.call(b);
    return false;
  }

  function isSpecialObject(value: unknown) {
    return (
      Array.isArray(value) ||
      ArrayBuffer.isView(value) ||
      isSet(value) ||
      isMap(value) ||
      isDate(value) ||
      isRegExp(value) ||
      isAnyArrayBuffer(value) ||
      isBoxedPrimitive(value) ||
      isNativeError(value) ||
      value instanceof Error
    );
  }

  function nodePrimitiveEqual(a: unknown, b: unknown, strict: boolean) {
    if (strict) return typeof a === "number" && a !== a && b !== b;
    if (b === null || typeof b !== "object") return a == b || (a !== a && b !== b);
    return false;
  }

  const ConstructorSet = Set;
  const constructors: Function[] = [Object, Array, Function, RegExp, Promise, String, Symbol, BigInt, Boolean, Number, Date, Error, Map, Set, WeakMap, WeakSet, ArrayBuffer, DataView];
  const wellKnownConstructors = new ConstructorSet<unknown>(
    constructors
      .concat([Int8Array, Int16Array, Int32Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array])
      .concat(typeof Float16Array === "function" ? [Float16Array] : []),
  );

  // Node's strict rule: an inherited (or well-known) constructor must match;
  // otherwise the prototypes themselves must be identical.
  function sameConstructorOrPrototype(val1: object, val2: object) {
    const ctor = val1.constructor;
    if (wellKnownConstructors.has(ctor) || (ctor !== undefined && !hasOwn(val1, "constructor"))) {
      return ctor === val2.constructor;
    }
    return Object.getPrototypeOf(val1) === Object.getPrototypeOf(val2);
  }

  function nodeDeepEqual(val1: unknown, val2: unknown, strict: boolean, memos?: BunWasm.EqualityMemo): boolean {
    if (val1 === val2) return val1 !== 0 || Object.is(val1, val2) || !strict;
    if (strict) {
      if (typeof val1 !== "object") return nodePrimitiveEqual(val1, val2, true);
      if (typeof val2 !== "object" || val1 === null || val2 === null) return false;
      if (!sameConstructorOrPrototype(val1, val2)) return false;
    } else {
      if (val1 === null || typeof val1 !== "object") return nodePrimitiveEqual(val1, val2, false);
      if (val2 === null || typeof val2 !== "object") return false;
    }
    if (tagOf(val1) !== tagOf(val2)) return false;
    return nodeCompareObjects(val1, val2, strict, memos);
  }

  function nodeCompareErrors(val1: BunWasm.ComparisonError, val2: unknown, strict: boolean, memos?: BunWasm.EqualityMemo): boolean {
    if (!isNativeError(val2) && !(val2 instanceof Error)) return false;
    if (val1.message !== val2.message || val1.name !== val2.name) return false;
    if (hasOwn(val1, "cause") !== hasOwn(val2, "cause")) return false;
    if (hasOwn(val1, "cause") && !nodeDeepEqual(val1.cause, val2.cause, strict, memos)) return false;
    if (hasOwn(val1, "errors") !== hasOwn(val2, "errors")) return false;
    return !hasOwn(val1, "errors") || nodeDeepEqual(val1.errors, (val2 as BunWasm.ComparisonError).errors, strict, memos);
  }

  function nodeCompareViews(val1: ArrayBufferView, val2: unknown, strict: boolean, memos?: BunWasm.EqualityMemo): boolean {
    if (typedArrayName(val1) !== typedArrayName(val2)) return false;
    if (!ArrayBuffer.isView(val2)) return false;
    const name = typedArrayName(val1);
    const isFloat = name === "Float32Array" || name === "Float64Array" || name === "Float16Array";
    if (!strict && isFloat) {
      if (!looseEqualElements(val1 as BunWasm.NumericView, val2 as BunWasm.NumericView)) return false;
    } else if (!equalBytes(bytesOf(val1), bytesOf(val2))) {
      return false;
    }
    const keys1 = nonIndexKeys(val1, strict);
    if (keys1.length !== nonIndexKeys(val2, strict).length) return false;
    return keyCheck(val1, val2, strict, memos, kNoIterator, keys1);
  }

  function nodeCompareObjects(val1: object, val2: object, strict: boolean, memos?: BunWasm.EqualityMemo): boolean {
    if (Array.isArray(val1)) {
      if (!Array.isArray(val2) || val1.length !== val2.length) return false;
      const keys1 = nonIndexKeys(val1, strict);
      if (keys1.length !== nonIndexKeys(val2, strict).length) return false;
      return keyCheck(val1, val2, strict, memos, kIsArray, keys1);
    }
    if (tagOf(val1) === "Object" && !isSpecialObject(val1) && !isSpecialObject(val2)) {
      return keyCheck(val1, val2, strict, memos, kNoIterator);
    }
    if (isDate(val1)) {
      const getTime = Date.prototype.getTime;
      if (!isDate(val2) || !Object.is(getTime.call(val1), getTime.call(val2))) return false;
    } else if (isRegExp(val1)) {
      if (!isRegExp(val2) || val1.source !== val2.source || val1.flags !== val2.flags) return false;
      if (val1.lastIndex !== val2.lastIndex) return false;
    } else if (isNativeError(val1) || val1 instanceof Error) {
      if (!nodeCompareErrors(val1, val2, strict, memos)) return false;
    } else if (ArrayBuffer.isView(val1)) {
      return nodeCompareViews(val1, val2, strict, memos);
    } else if (isSet(val1)) {
      if (!isSet(val2) || val1.size !== val2.size) return false;
      return keyCheck(val1, val2, strict, memos, kIsSet);
    } else if (isMap(val1)) {
      if (!isMap(val2) || val1.size !== val2.size) return false;
      return keyCheck(val1, val2, strict, memos, kIsMap);
    } else if (isAnyArrayBuffer(val1)) {
      if (!isAnyArrayBuffer(val2) || !equalBytes(new Uint8Array(val1), new Uint8Array(val2))) return false;
    } else if (isBoxedPrimitive(val1)) {
      if (!equalBoxed(val1, val2)) return false;
    } else if (isSpecialObject(val2)) {
      return false;
    } else if (strict && (types.isWeakMap(val1) || types.isWeakSet(val1) || isPromise(val1))) {
      // Their contents are unobservable; only identical instances are equal.
      return false;
    }
    return keyCheck(val1, val2, strict, memos, kNoIterator);
  }

  function enumerableSymbols(obj: object) {
    return Object.getOwnPropertySymbols(obj).filter((sym) => isEnumerable(obj, sym));
  }

  function keyCheck(val1: unknown[], val2: unknown[], strict: boolean, memos: BunWasm.EqualityMemo | undefined, iterationType: 1, providedKeys?: (string | symbol)[]): boolean;
  function keyCheck(val1: Set<unknown>, val2: Set<unknown>, strict: boolean, memos: BunWasm.EqualityMemo | undefined, iterationType: 2, providedKeys?: (string | symbol)[]): boolean;
  function keyCheck(val1: Map<unknown, unknown>, val2: Map<unknown, unknown>, strict: boolean, memos: BunWasm.EqualityMemo | undefined, iterationType: 3, providedKeys?: (string | symbol)[]): boolean;
  function keyCheck(val1: object, val2: object, strict: boolean, memos: BunWasm.EqualityMemo | undefined, iterationType: 0, providedKeys?: (string | symbol)[]): boolean;
  function keyCheck(val1: object, val2: object, strict: boolean, memos: BunWasm.EqualityMemo | undefined, iterationType: 0 | 1 | 2 | 3, providedKeys?: (string | symbol)[]): boolean {
    let aKeys = providedKeys;
    if (aKeys === undefined) {
      aKeys = Object.keys(val1);
      if (aKeys.length !== Object.keys(val2).length) return false;
    }
    for (const key of aKeys) {
      if (!isEnumerable(val2, key)) return false;
    }
    if (strict && providedKeys === undefined) {
      const symbolsA = enumerableSymbols(val1);
      const symbolsB = enumerableSymbols(val2);
      if (symbolsA.length !== symbolsB.length) return false;
      for (const sym of symbolsA) {
        if (!isEnumerable(val2, sym)) return false;
      }
      aKeys = aKeys.concat(symbolsA);
    }
    const empty = aKeys.length === 0;
    if (empty && iterationType === kNoIterator) return true;
    if (empty && iterationType === kIsArray && (val1 as unknown[]).length === 0) return true;
    if (empty && (iterationType === kIsSet || iterationType === kIsMap) && (val1 as Set<unknown> | Map<unknown, unknown>).size === 0) return true;
    return withMemo(val1, val2, memos, (memo) => objEquiv(val1, val2, strict, aKeys, memo, iterationType));
  }

  // Cycle detection shared by both deep-equality flavours (Node's memo scheme).
  function withMemo(val1: object, val2: object, memos: BunWasm.EqualityMemo | undefined, compare: (memo: BunWasm.EqualityMemo) => boolean): boolean {
    let memo = memos;
    if (memo === undefined) {
      memo = { val1: new Map(), val2: new Map(), position: 0 };
    } else {
      const memoA = memo.val1.get(val1);
      if (memoA !== undefined) {
        const memoB = memo.val2.get(val2);
        if (memoB !== undefined) return memoA === memoB;
      }
      memo.position++;
    }
    memo.val1.set(val1, memo.position);
    memo.val2.set(val2, memo.position);
    const result = compare(memo);
    memo.val1.delete(val1);
    memo.val2.delete(val2);
    return result;
  }

  function arrayEquiv(a: unknown[], b: unknown[], strict: boolean, memos: BunWasm.EqualityMemo): boolean {
    for (let i = 0; i < a.length; i++) {
      if (hasOwn(a, i)) {
        if (!hasOwn(b, i) || !nodeDeepEqual(a[i], b[i], strict, memos)) return false;
        continue;
      }
      if (hasOwn(b, i)) return false;
      // Sparse array: compare the remaining keys in bulk.
      const keysA = Object.keys(a);
      for (const key of keysA) {
        if (!hasOwn(b, key) || !nodeDeepEqual((a as unknown[] & Record<string, unknown>)[key], (b as unknown[] & Record<string, unknown>)[key], strict, memos)) return false;
      }
      return keysA.length === Object.keys(b).length;
    }
    return true;
  }

  function objEquiv(a: object, b: object, strict: boolean, keys: (string | symbol)[], memos: BunWasm.EqualityMemo, iterationType: 0 | 1 | 2 | 3): boolean {
    if (iterationType === kIsSet && !setEquiv(a as Set<unknown>, b as Set<unknown>, strict, memos)) return false;
    if (iterationType === kIsMap && !mapEquiv(a as Map<unknown, unknown>, b as Map<unknown, unknown>, strict, memos)) return false;
    if (iterationType === kIsArray && !arrayEquiv(a as unknown[], b as unknown[], strict, memos)) return false;
    for (const key of keys) {
      if (!nodeDeepEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key], strict, memos)) return false;
    }
    return true;
  }

  function findLooseMatchingPrimitives(prim: unknown) {
    switch (typeof prim) {
      case "undefined":
        return null;
      case "object":
        return undefined;
      case "symbol":
        return false;
      case "string":
        return Number.isNaN(+prim) ? false : true;
      case "number":
        return Number.isNaN(prim) ? false : true;
    }
    return true;
  }

  function setMightHaveLoosePrim(a: Set<unknown>, b: Set<unknown>, prim: unknown) {
    const altValue = findLooseMatchingPrimitives(prim);
    if (altValue != null) return altValue;
    return b.has(altValue) && !a.has(altValue);
  }

  function mapMightHaveLoosePrim(a: Map<unknown, unknown>, b: Map<unknown, unknown>, prim: unknown, item: unknown, memo: BunWasm.EqualityMemo) {
    const altValue = findLooseMatchingPrimitives(prim);
    if (altValue != null) return altValue;
    const curB = b.get(altValue);
    if ((curB === undefined && !b.has(altValue)) || !nodeDeepEqual(item, curB, false, memo)) return false;
    return !a.has(altValue) && nodeDeepEqual(item, curB, false, memo);
  }

  function setHasEqualElement(set: Set<unknown>, val1: unknown, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    for (const val2 of set) {
      if (nodeDeepEqual(val1, val2, strict, memo)) {
        set.delete(val2);
        return true;
      }
    }
    return false;
  }

  function isObjectValue(value: unknown) {
    return typeof value === "object" && value !== null;
  }

  function setEquiv(a: Set<unknown>, b: Set<unknown>, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    let set: Set<unknown> | null = null;
    for (const val of a) {
      if (isObjectValue(val)) {
        set = set || new Set();
        set.add(val);
      } else if (!b.has(val)) {
        if (strict || !setMightHaveLoosePrim(a, b, val)) return false;
        set = set || new Set();
        set.add(val);
      }
    }
    if (set === null) return true;
    for (const val of b) {
      if (isObjectValue(val)) {
        if (!setHasEqualElement(set, val, strict, memo)) return false;
      } else if (!strict && !a.has(val) && !setHasEqualElement(set, val, strict, memo)) {
        return false;
      }
    }
    return set.size === 0;
  }

  function mapHasEqualEntry(set: Set<unknown>, map: Map<unknown, unknown>, key1: unknown, item1: unknown, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    for (const key2 of set) {
      if (nodeDeepEqual(key1, key2, strict, memo) && nodeDeepEqual(item1, map.get(key2), strict, memo)) {
        set.delete(key2);
        return true;
      }
    }
    return false;
  }

  function mapEquiv(a: Map<unknown, unknown>, b: Map<unknown, unknown>, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    let set: Set<unknown> | null = null;
    for (const [key, item1] of a) {
      if (isObjectValue(key)) {
        set = set || new Set();
        set.add(key);
        continue;
      }
      const item2 = b.get(key);
      if ((item2 !== undefined || b.has(key)) && nodeDeepEqual(item1, item2, strict, memo)) continue;
      if (strict || !mapMightHaveLoosePrim(a, b, key, item1, memo)) return false;
      set = set || new Set();
      set.add(key);
    }
    if (set === null) return true;
    for (const [key, item] of b) {
      if (isObjectValue(key)) {
        if (!mapHasEqualEntry(set, a, key, item, strict, memo)) return false;
      } else if (
        !strict &&
        (!a.has(key) || !nodeDeepEqual(a.get(key), item, false, memo)) &&
        !mapHasEqualEntry(set, a, key, item, false, memo)
      ) {
        return false;
      }
    }
    return set.size === 0;
  }

  function isDeepStrictEqual(a: unknown, b: unknown) {
    return nodeDeepEqual(a, b, true);
  }

  // ---------------------------------------------------------------------------
  // Bun.deepEquals semantics
  // ---------------------------------------------------------------------------
  // - primitives compare with Object.is (so 0 !== -0, NaN === NaN, 1 !== "1")
  // - non-strict: properties whose value is undefined count as absent, array
  //   holes equal undefined, prototypes are ignored
  // - strict: constructor names and built-in tags must match, holes matter
  // - Date/RegExp/Map/Set/ArrayBuffer compare contents only; arrays ignore
  //   non-index properties; errors compare name, message, cause and own props

  function constructorName(obj: object) {
    const proto = Object.getPrototypeOf(obj);
    if (proto === null) return "Object";
    const ctor = proto.constructor;
    return typeof ctor === "function" && ctor.name ? ctor.name : "Object";
  }

  function bunDeepEquals(a: unknown, b: unknown, strict?: boolean) {
    return bunEq(a, b, strict === true, undefined);
  }

  function bunEq(a: unknown, b: unknown, strict: boolean, memo?: BunWasm.EqualityMemo): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    return withMemo(a, b, memo, (m) => bunCompareObjects(a, b, strict, m));
  }

  function bunCompareSets(a: Set<unknown>, b: unknown, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    if (!isSet(b) || a.size !== b.size) return false;
    for (const v of a) {
      if (b.has(v)) continue;
      let found = false;
      for (const w of b) {
        if (bunEq(v, w, strict, memo)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function bunCompareMaps(a: Map<unknown, unknown>, b: unknown, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    if (!isMap(b) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (b.has(k)) {
        if (!bunEq(v, b.get(k), strict, memo)) return false;
        continue;
      }
      let found = false;
      for (const [k2, v2] of b) {
        if (bunEq(k, k2, strict, memo) && bunEq(v, v2, strict, memo)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function bunCompareTypedArrays(a: BunWasm.NumericView, b: BunWasm.NumericView, strict: boolean) {
    if (typedArrayName(a) !== typedArrayName(b) || a.length !== b.length) return false;
    if (strict) return equalBytes(bytesOf(a), bytesOf(b));
    for (let i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  function bunCompareArrays(a: unknown[], b: unknown, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    if (!Array.isArray(b)) return false;
    if (strict && a.length !== b.length) return false;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (strict && hasOwn(a, i) !== hasOwn(b, i)) return false;
      if (!bunEq(a[i], b[i], strict, memo)) return false;
    }
    return true;
  }

  function bunCompareErrors(a: Error, b: unknown, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    if (!(isNativeError(b) || b instanceof Error)) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a.name !== b.name || a.message !== b.message) return false;
    if (hasOwn(a, "cause") || hasOwn(b, "cause")) {
      if (!bunEq(a.cause, b.cause, strict, memo)) return false;
    }
    return true;
  }

  // Type-specific comparison; returns true/false, or undefined to continue with properties.
  function bunCompareSpecial(a: object, b: object, strict: boolean, memo: BunWasm.EqualityMemo): boolean | undefined {
    if (isSet(a) || isSet(b)) return isSet(a) && bunCompareSets(a, b, strict, memo);
    if (isMap(a) || isMap(b)) return isMap(a) && bunCompareMaps(a, b, strict, memo);
    if (isAnyArrayBuffer(a) || isAnyArrayBuffer(b)) {
      if (isArrayBuffer(a) !== isArrayBuffer(b) || isSharedArrayBuffer(a) !== isSharedArrayBuffer(b)) return false;
      return equalBytes(new Uint8Array(a as ArrayBuffer | SharedArrayBuffer), new Uint8Array(b as ArrayBuffer | SharedArrayBuffer));
    }
    if (isDate(a) || isDate(b)) return isDate(a) && isDate(b) && a.getTime() === b.getTime();
    if (isRegExp(a) || isRegExp(b)) return isRegExp(a) && isRegExp(b) && a.source === b.source && a.flags === b.flags;
    if (isTypedArray(a) || isTypedArray(b)) {
      if (!isTypedArray(a) || !isTypedArray(b) || !bunCompareTypedArrays(a, b, strict)) return false;
      return strict ? undefined : true;
    }
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && bunCompareArrays(a, b, strict, memo);
    if (isBoxedPrimitive(a) || isBoxedPrimitive(b)) {
      if (!equalBoxed(a, b)) return false;
      return strict ? undefined : true;
    }
    if (isNativeError(a) || isNativeError(b)) return isNativeError(a) && bunCompareErrors(a, b, strict, memo) ? undefined : false;
    return undefined;
  }

  function ownEnumerableKeys(obj: object): (string | symbol)[] {
    const keys: (string | symbol)[] = Object.keys(obj);
    return keys.concat(enumerableSymbols(obj));
  }

  function bunCompareObjects(a: object, b: object, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    const special = bunCompareSpecial(a, b, strict, memo);
    if (special !== undefined) return special;
    if (isTypedArray(a) || isBoxedPrimitive(a)) return bunStrictProps(a, b, memo, nonIndexKeys(a, true));
    if (strict && (tagOf(a) !== tagOf(b) || constructorName(a) !== constructorName(b))) return false;
    if (isPlainLayout(a) && isPlainLayout(b)) return bunFastProps(a, b, strict, memo);
    return bunSlowProps(a, b, strict, memo);
  }

  // Mirrors JSC's fast property enumeration: no indexed or accessor own
  // properties, no own "__proto__" and no exotic arguments object.
  function isPlainLayout(obj: object) {
    if (tagOf(obj) === "Arguments" || hasOwn(obj, "__proto__")) return false;
    for (const key of Reflect.ownKeys(obj)) {
      if (isIndexKey(key)) return false;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc && (desc.get || desc.set)) return false;
    }
    return true;
  }

  function bunStrictProps(a: object, b: object, memo: BunWasm.EqualityMemo, keysA: (string | symbol)[]): boolean {
    if (keysA.length !== nonIndexKeys(b, true).length) return false;
    for (const key of keysA) {
      if (!isEnumerable(b, key) || !bunEq((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key], true, memo)) return false;
    }
    return true;
  }

  // Own-property comparison. Non-strict lookups on the other side also see
  // non-enumerable own properties, like JSC's getDirect().
  function bunFastProps(a: object, b: object, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    const keysA = ownEnumerableKeys(a);
    for (const key of keysA) {
      const present = strict ? isEnumerable(b, key) : hasOwn(b, key);
      if (!strict && (a as Record<PropertyKey, unknown>)[key] === undefined && !present) continue;
      if (!present || !bunEq((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key], strict, memo)) return false;
    }
    let remain = keysA.length;
    for (const key of ownEnumerableKeys(b)) {
      if (!strict && (b as Record<PropertyKey, unknown>)[key] === undefined) continue;
      if (!hasOwn(a, key) || remain === 0) return false;
      remain--;
    }
    return true;
  }

  function forInKeys(obj: object): (string | symbol)[] {
    const keys: (string | symbol)[] = [];
    for (const key in obj) keys.push(key);
    return keys.concat(enumerableSymbols(obj));
  }

  // JSC's generic path: enumerable keys including inherited ones; keys of `b`
  // beyond the length of `a`'s list only need to hold undefined.
  function bunSlowProps(a: object, b: object, strict: boolean, memo: BunWasm.EqualityMemo): boolean {
    const keysA = forInKeys(a);
    const keysB = forInKeys(b);
    if (strict && keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      const value = (a as Record<PropertyKey, unknown>)[key];
      const present = key in b;
      if (!strict && value === undefined && !present) continue;
      if (!present || !bunEq(value, (b as Record<PropertyKey, unknown>)[key], strict, memo)) return false;
    }
    for (let i = keysA.length; i < keysB.length; i++) {
      if ((b as Record<PropertyKey, unknown>)[keysB[i]] !== undefined) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Strings: styleText, stripVTControlCharacters, toUSVString
  // ---------------------------------------------------------------------------

  const ansiPattern =
    "[\\u001B\\u009B][[\\]()#;?]*" +
    "(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*" +
    "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?" +
    "(?:\\u0007|\\u001B\\u005C|\\u009C))" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))";
  const ansiRegex = new RegExp(ansiPattern, "g");

  function stripVTControlCharacters(str: unknown) {
    validateString(str, "str");
    return str.replace(ansiRegex, "");
  }

  function toUSVString(input: unknown) {
    const str = String(input);
    if (typeof str.toWellFormed === "function") return str.toWellFormed();
    return str.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
  }

  function envOf() {
    return typeof process !== "undefined" && process.env ? process.env : {};
  }

  function streamHasColors(stream: BunWasm.ColorStream | undefined) {
    const env = envOf();
    if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
    if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined) return false;
    if (!stream) return false;
    if (typeof stream.hasColors === "function") return stream.hasColors();
    return stream.isTTY === true && env.TERM !== "dumb";
  }

  function styleText(formatArg: string | string[], text: unknown, options?: { validateStream?: boolean; stream?: BunWasm.ColorStream }) {
    validateString(text, "text");
    const validateStream = options && options.validateStream !== undefined ? options.validateStream : true;
    const stream =
      options && options.stream !== undefined ? options.stream : typeof process !== "undefined" ? process.stdout : undefined;
    const formats = Array.isArray(formatArg) ? formatArg : [formatArg];
    let left = "";
    let right = "";
    for (const key of formats) {
      const code = hasOwn(ansiColors, key) ? ansiColors[key] : undefined;
      if (code === undefined) throw invalidFormat(key);
      left += `\u001b[${code[0]}m`;
      right = `\u001b[${code[1]}m${right}`;
    }
    if (validateStream && !streamHasColors(stream)) return text;
    return `${left}${text}${right}`;
  }

  function invalidFormat(key: unknown) {
    const allowed = Object.keys(ansiColors)
      .map((name) => `'${name}'`)
      .join(", ");
    const shown = typeof key === "string" ? `'${key}'` : inspect(key);
    return makeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'format' must be one of: ${allowed}. Received ${shown}`);
  }

  // ---------------------------------------------------------------------------
  // debuglog
  // ---------------------------------------------------------------------------

  let debugPattern: RegExp | null | undefined;

  function debugEnabledFor(section: string) {
    if (debugPattern === undefined) {
      const value = envOf().NODE_DEBUG;
      if (!value) {
        debugPattern = null;
      } else {
        const escaped = value
          .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/,/g, "$|^");
        debugPattern = new RegExp(`^${escaped}$`, "i");
      }
    }
    return debugPattern !== null && debugPattern.test(section);
  }

  function debuglog(section: unknown, cb?: (logger: () => void) => void) {
    const upper = String(section).toUpperCase();
    let enabled: boolean | undefined;
    function logger() {
      if (enabled === undefined) {
        enabled = debugEnabledFor(upper);
        if (typeof cb === "function") cb(enabled ? logger : () => {});
      }
      if (!enabled) return;
      const pid = typeof process !== "undefined" && process.pid !== undefined ? process.pid : 0;
      console.error("%s %d: %s", upper, pid, (format as { apply(receiver: unknown, args: IArguments): string }).apply(null, arguments));
    }
    Object.defineProperty(logger, "enabled", {
      configurable: true,
      enumerable: true,
      get() {
        if (enabled === undefined) enabled = debugEnabledFor(upper);
        return enabled;
      },
    });
    return logger;
  }

  // ---------------------------------------------------------------------------
  // parseArgs (port of Node's lib/internal/util/parse_args)
  // ---------------------------------------------------------------------------

  // Bun words parseArgs validation errors as `The "x" property must be ..., got <type>`.
  function argsTypeError(name: string, expected: string, value: unknown) {
    const got = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    return makeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" property must be ${expected}, got ${got}`);
  }

  function argsCheck(ok: boolean, name: string, expected: string, value: unknown): asserts ok {
    if (!ok) throw argsTypeError(name, expected, value);
  }

  function parseArgsError(code: string, message: string) {
    return makeError(TypeError, code, message);
  }

  function objectGetOwn(obj: unknown, key: string): unknown {
    return obj && hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
  }

  function optionsGetOwn(options: Record<PropertyKey, unknown>, longOption: unknown, key: string) {
    return hasOwn(options, longOption as PropertyKey) ? objectGetOwn(options[longOption as PropertyKey], key) : undefined;
  }

  function findLongOptionForShort(shortOption: unknown, options: Record<PropertyKey, unknown>) {
    const entry = Object.entries(options).find(([, config]) => objectGetOwn(config, "short") === shortOption);
    return entry ? entry[0] : shortOption;
  }

  const isOptionValue = (value: unknown) => value != null;
  const isOptionLikeValue = (value: unknown) => value != null && (value as { length: number }).length > 1 && (value as { [index: number]: unknown })[0] === "-";
  const isLoneShortOption = (arg: unknown) => (arg as { length: unknown }).length === 2 && (arg as { [index: number]: unknown })[0] === "-" && (arg as { [index: number]: unknown })[1] !== "-";
  const isLoneLongOption = (arg: unknown) => (arg as { length: number }).length > 2 && (arg as { startsWith(prefix: unknown): unknown }).startsWith("--") && !(arg as { includes(value: unknown, start: unknown): unknown }).includes("=", 3);
  const isLongOptionAndValue = (arg: unknown) => (arg as { length: number }).length > 2 && (arg as { startsWith(prefix: unknown): unknown }).startsWith("--") && (arg as { includes(value: unknown, start: unknown): unknown }).includes("=", 3);

  function isShortOptionStart(arg: unknown) {
    return (arg as { length: number }).length > 2 && (arg as { [index: number]: unknown })[0] === "-" && (arg as { [index: number]: unknown })[1] !== "-";
  }

  function shortTakesValue(arg: unknown, options: Record<PropertyKey, unknown>) {
    return optionsGetOwn(options, findLongOptionForShort((arg as { [index: number]: unknown })[1], options), "type") === "string";
  }

  function expandShortGroup(arg: unknown, options: Record<PropertyKey, unknown>) {
    const expanded = [];
    for (let i = 1; i < (arg as { length: number }).length; i++) {
      const shortOption = (arg as { [index: number]: unknown })[i];
      const longOption = findLongOptionForShort(shortOption, options);
      if (optionsGetOwn(options, longOption, "type") !== "string" || i === (arg as { length: number }).length - 1) {
        expanded.push(`-${shortOption}`);
        continue;
      }
      // String option inside a group: the rest of the group is its value.
      expanded.push(`-${(arg as { slice(start: unknown, end?: unknown): unknown }).slice(i)}`);
      break;
    }
    return expanded;
  }

  function optionToken(name: unknown, rawName: unknown, index: number, value: unknown, inlineValue: boolean | undefined): BunWasm.OptionToken {
    return { kind: "option", name, rawName, index, value, inlineValue };
  }

  // Tokens expanded from a short-option group ("-abc"); Bun names them without the dash.
  const groupTokens = new WeakSet<BunWasm.OptionToken>();

  function argsToTokens(args: unknown[], options: Record<PropertyKey, unknown>) {
    const tokens: BunWasm.ParseToken[] = [];
    let index = -1;
    let groupCount = 0;
    const remaining = args.slice();
    while (remaining.length > 0) {
      const arg = remaining.shift();
      const nextArg = remaining[0];
      const inGroup = groupCount > 0;
      if (inGroup) groupCount--;
      else index++;

      if (arg === "--") {
        tokens.push({ kind: "option-terminator", index });
        for (const rest of remaining) tokens.push({ kind: "positional", index: ++index, value: rest });
        break;
      }
      if (isLoneShortOption(arg)) {
        const longOption = findLongOptionForShort((arg as { [index: number]: unknown })[1], options);
        const takesValue = optionsGetOwn(options, longOption, "type") === "string" && isOptionValue(nextArg);
        const value = takesValue ? remaining.shift() : undefined;
        const token = optionToken(longOption, arg, index, value, takesValue ? false : undefined);
        if (inGroup) groupTokens.add(token);
        tokens.push(token);
        if (value != null) ++index;
        continue;
      }
      if (isShortOptionStart(arg) && !shortTakesValue(arg, options)) {
        const expanded = expandShortGroup(arg, options);
        remaining.unshift.apply(remaining, expanded);
        groupCount = expanded.length;
        continue;
      }
      if (isShortOptionStart(arg)) {
        const longOption = findLongOptionForShort((arg as { [index: number]: unknown })[1], options);
        tokens.push(optionToken(longOption, `-${(arg as { [index: number]: unknown })[1]}`, index, (arg as { slice(start: unknown, end?: unknown): unknown }).slice(2), true));
        continue;
      }
      if (isLoneLongOption(arg)) {
        const longOption = (arg as { slice(start: unknown, end?: unknown): unknown }).slice(2);
        const takesValue = optionsGetOwn(options, longOption, "type") === "string" && isOptionValue(nextArg);
        const value = takesValue ? remaining.shift() : undefined;
        tokens.push(optionToken(longOption, arg, index, value, takesValue ? false : undefined));
        if (value != null) ++index;
        continue;
      }
      if (isLongOptionAndValue(arg)) {
        const equalIndex = (arg as { indexOf(value: unknown): unknown }).indexOf("=");
        const longOption = (arg as { slice(start: unknown, end?: unknown): unknown }).slice(2, equalIndex);
        tokens.push(optionToken(longOption, `--${longOption}`, index, (arg as { slice(start: unknown, end?: unknown): unknown }).slice((equalIndex as number) + 1), true));
        continue;
      }
      tokens.push({ kind: "positional", index, value: arg });
    }
    return tokens;
  }

  function checkOptionLikeValue(token: BunWasm.OptionToken) {
    if (token.inlineValue || !isOptionLikeValue(token.value)) return;
    const example = (token.rawName as { startsWith(prefix: unknown): unknown }).startsWith("--")
      ? `'${token.rawName}=-XYZ'`
      : `'--${token.name}=-XYZ' or '${token.rawName}-XYZ'`;
    throw parseArgsError(
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
      `Option '${token.rawName}' argument is ambiguous.\nDid you forget to specify the option argument for '${token.rawName}'?\nTo specify an option argument starting with a dash use ${example}.`,
    );
  }

  function unknownOption(rawName: unknown, allowPositionals: boolean) {
    const suggestDashDash = allowPositionals
      ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(rawName)}`
      : "";
    return parseArgsError("ERR_PARSE_ARGS_UNKNOWN_OPTION", `Unknown option '${rawName}'${suggestDashDash}`);
  }

  function checkOptionUsage(config: { options: Record<PropertyKey, unknown>; allowNegative: boolean; allowPositionals: boolean }, token: BunWasm.OptionToken) {
    let name = token.name;
    if (!hasOwn(config.options, name as PropertyKey)) {
      const negated = config.allowNegative && (name as { startsWith(prefix: unknown): unknown }).startsWith("no-");
      const shownName = groupTokens.has(token) ? token.name : token.rawName;
      if (!negated) throw unknownOption(shownName, config.allowPositionals);
      name = (name as { slice(start: unknown, end?: unknown): unknown }).slice(3);
      if (optionsGetOwn(config.options, name, "type") !== "boolean") {
        throw unknownOption(shownName, config.allowPositionals);
      }
    }
    const short = optionsGetOwn(config.options, name, "short");
    const shortAndLong = `${short ? `-${short}, ` : ""}--${name}`;
    const type = optionsGetOwn(config.options, name, "type");
    if (type === "string" && typeof token.value !== "string") {
      throw parseArgsError("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '${shortAndLong} <value>' argument missing`);
    }
    if (type === "boolean" && token.value != null) {
      throw parseArgsError("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '${shortAndLong}' does not take an argument`);
    }
  }

  function storeOption(longOption: unknown, optionValue: unknown, options: Record<PropertyKey, unknown>, values: Record<PropertyKey, unknown>, allowNegative: boolean) {
    if (longOption === "__proto__") return;
    let name = longOption;
    let value = optionValue === undefined ? true : optionValue;
    if (allowNegative && (name as { startsWith(prefix: unknown): unknown }).startsWith("no-") && optionValue === undefined && !hasOwn(options, name as PropertyKey)) {
      name = (name as { slice(start: unknown, end?: unknown): unknown }).slice(3);
      value = false;
    }
    if (!optionsGetOwn(options, name, "multiple")) {
      values[name as PropertyKey] = value;
      return;
    }
    if (values[name as PropertyKey] === undefined) values[name as PropertyKey] = [value];
    else (values[name as PropertyKey] as { push(value: unknown): unknown }).push(value);
  }

  function validateDefault(type: string, multiple: unknown, value: unknown, name: string) {
    if (!multiple) return argsCheck(typeof value === type, name, `of type ${type}`, value);
    argsCheck(Array.isArray(value), name, "an instance of Array", value);
    // Bun reports the array itself as the received value for a bad element.
    value.forEach((item, i) => argsCheck(typeof item === type, `${name}[${i}]`, `of type ${type}`, value));
  }

  function isPlainObjectArg(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function validateOptionConfig(longOption: string, config: unknown) {
    argsCheck(isPlainObjectArg(config), `options.${longOption}`, "of type object", config);
    const type = objectGetOwn(config, "type");
    if (type !== "string" && type !== "boolean") {
      throw makeError(TypeError, "ERR_INVALID_ARG_TYPE", `options.${longOption}.type must be one of: boolean|string`);
    }
    if (hasOwn(config, "short")) {
      const short = config.short;
      argsCheck(typeof short === "string", `options.${longOption}.short`, "of type string", short);
      if (short.length !== 1) {
        throw makeError(TypeError, "ERR_INVALID_ARG_VALUE", `options.${longOption}.short must be a single character`);
      }
    }
    const multiple = objectGetOwn(config, "multiple");
    if (hasOwn(config, "multiple")) {
      argsCheck(typeof multiple === "boolean", `options.${longOption}.multiple`, "of type boolean", multiple);
    }
    const defaultValue = objectGetOwn(config, "default");
    if (defaultValue !== undefined) validateDefault(type, multiple, defaultValue, `options.${longOption}.default`);
  }

  function mainArgs() {
    if (typeof process === "undefined" || !Array.isArray(process.argv)) return [];
    return process.argv.slice(2);
  }

  function parseArgs(config: unknown = {}) {
    const args = objectGetOwn(config, "args") ?? mainArgs();
    const strict = objectGetOwn(config, "strict") ?? true;
    const allowPositionals = objectGetOwn(config, "allowPositionals") ?? !strict;
    const returnTokens = objectGetOwn(config, "tokens") ?? false;
    const allowNegative = objectGetOwn(config, "allowNegative") ?? false;
    const options = objectGetOwn(config, "options") ?? { __proto__: null };
    const parseConfig: { args: unknown; strict: unknown; options: unknown; allowPositionals: unknown; allowNegative: unknown } = { args, strict, options, allowPositionals, allowNegative };

    argsCheck(Array.isArray(args), "args", "an instance of Array", args);
    argsCheck(typeof strict === "boolean", "strict", "of type boolean", strict);
    argsCheck(typeof allowPositionals === "boolean", "allowPositionals", "of type boolean", allowPositionals);
    argsCheck(typeof returnTokens === "boolean", "tokens", "of type boolean", returnTokens);
    argsCheck(typeof allowNegative === "boolean", "allowNegative", "of type boolean", allowNegative);
    argsCheck(isPlainObjectArg(options), "options", "of type object", options);
    for (const [longOption, optionConfig] of Object.entries(options)) validateOptionConfig(longOption, optionConfig);

    const tokens = argsToTokens(args, options);
    const result: BunWasm.ParseArgsResult = { values: { __proto__: null }, positionals: [] };
    if (returnTokens) result.tokens = tokens;

    function storeNegativeOption(token: BunWasm.OptionToken, options: Record<PropertyKey, unknown>, values: Record<PropertyKey, unknown>) {
      if (!(token.name as { startsWith(prefix: unknown): unknown }).startsWith("no-") || token.value !== undefined || hasOwn(options, token.name as PropertyKey)) return false;
      const positive = (token.name as { slice(start: unknown): unknown }).slice(3);
      if (optionsGetOwn(options, positive, "type") !== "boolean") return false;
      token.name = positive;
      storeOption(positive, false, options, values, false);
      return true;
    }

    for (const token of tokens) {
      if (token.kind === "option") {
        if (allowNegative && storeNegativeOption(token, options, result.values)) continue;
        if (strict) {
          checkOptionUsage(parseConfig as { options: Record<PropertyKey, unknown>; allowNegative: boolean; allowPositionals: boolean }, token);
          checkOptionLikeValue(token);
        }
        storeOption(token.name, token.value, options, result.values, allowNegative);
      } else if (token.kind === "positional") {
        if (!allowPositionals) {
          throw parseArgsError(
            "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
            `Unexpected argument '${token.value}'. This command does not take positional arguments`,
          );
        }
        result.positionals.push(token.value);
      }
    }

    for (const [longOption, optionConfig] of Object.entries(options)) {
      const defaultValue = objectGetOwn(optionConfig, "default");
      if (defaultValue === undefined || result.values[longOption] !== undefined || longOption === "__proto__") continue;
      result.values[longOption] = defaultValue;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Legacy helpers and module object
  // ---------------------------------------------------------------------------

  function parseEnv(content: unknown): Record<string, string> {
    if (typeof content !== "string") throw invalidArgType("content", "of type string", content);
    return internal.native.parseEnv(content);
  }

  function isError(e: unknown) {
    return isNativeError(e) || objectToString.call(e) === "[object Error]" || e instanceof Error;
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad2 = (n: number) => String(n).padStart(2, "0");

  function log() {
    const d = new Date();
    const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join(":");
    console.log("%s - %s", `${d.getDate()} ${months[d.getMonth()]} ${time}`, (format as { apply(receiver: unknown, args: IArguments): string }).apply(null, arguments));
  }

  function extend(target: Record<string, unknown>, source: unknown) {
    if (source === null || typeof source !== "object") return target;
    for (const key of Object.keys(source)) target[key] = (source as Record<string, unknown>)[key];
    return target;
  }

  function isBuffer(value: unknown) {
    return internal.require("buffer").Buffer.isBuffer(value);
  }

  return {
    _extend: extend,
    callbackify,
    debug: debuglog,
    debuglog,
    deprecate,
    format,
    formatWithOptions,
    inherits,
    inspect,
    isArray: Array.isArray,
    isBoolean: (arg: unknown) => typeof arg === "boolean",
    isBuffer,
    isDate,
    isDeepStrictEqual,
    isError,
    isFunction: (arg: unknown) => typeof arg === "function",
    isNull: (arg: unknown) => arg === null,
    isNullOrUndefined: (arg: unknown) => arg === null || arg === undefined,
    isNumber: (arg: unknown) => typeof arg === "number",
    isObject: (arg: unknown) => arg !== null && typeof arg === "object",
    // Bun reports bigints as non-primitive here.
    isPrimitive: (arg: unknown) => arg === null || (typeof arg !== "object" && typeof arg !== "function" && typeof arg !== "bigint"),
    isRegExp,
    isString: (arg: unknown) => typeof arg === "string",
    isSymbol: (arg: unknown) => typeof arg === "symbol",
    isUndefined: (arg: unknown) => arg === undefined,
    log,
    parseArgs,
    parseEnv,
    promisify,
    stripVTControlCharacters,
    styleText,
    toUSVString,
    types,
    TextDecoder: typeof TextDecoder === "function" ? TextDecoder : undefined,
    TextEncoder: typeof TextEncoder === "function" ? TextEncoder : undefined,
    _deepEqual: nodeDeepEqual,
    bunDeepEquals,
  };
});
