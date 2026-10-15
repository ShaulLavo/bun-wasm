// Bun-compatible console.log / Bun.inspect formatting, plus Node's util.inspect.
//
// Evaluated as a classic script; the completion value is the factory below.
// The runtime calls it once with engine hooks:
//   internal.promiseState(p)      -> "pending" | "fulfilled" | "rejected"
//   internal.promiseResult(p)     -> value / reason
//   internal.isProxy(v)           -> boolean
//   internal.getSourceLine(f, n)  -> string | undefined (1-based line)
//   internal.isESMNamespace(v)    -> boolean
// Optional hooks (feature-detected):
//   internal.getProxyTarget(p)    -> target object (Bun prints a proxy as its target)
//   internal.isError(v) / internal.isPromise(v) -> exact brand checks
//   internal.iteratorEntries(it)  -> array of the remaining entries of a Map/Set
//                                    iterator, without advancing it
//
// The Bun half is a port of ConsoleObject.rs (Formatter::print_as and friends)
// and VirtualMachine.rs (print_error_instance_body). Line breaking depends on
// the `estimatedLineLength` bookkeeping, so the places that bump it mirror the
// Rust code exactly, including the places where Bun does NOT count output.
(function (internal) {
  "use strict";

  const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
  const objectToString = Object.prototype.toString;
  const functionToString = Function.prototype.toString;
  const hasOwn = Object.prototype.hasOwnProperty;
  const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayTagGetter = Object.getOwnPropertyDescriptor(TypedArrayPrototype, Symbol.toStringTag).get;
  const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
  const sharedArrayBufferByteLength =
    typeof SharedArrayBuffer === "function"
      ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get
      : undefined;
  const regExpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get;
  const nativeIsError = typeof Error.isError === "function" ? Error.isError : undefined;

  // ───────────────────────────── brand checks ─────────────────────────────

  function succeeds(fn, value) {
    try {
      fn.call(value);
      return true;
    } catch {
      return false;
    }
  }

  const isMap = (v) => succeeds(Map.prototype.has, v);
  const isSet = (v) => succeeds(Set.prototype.has, v);
  const isWeakMap = (v) => succeeds(WeakMap.prototype.has, v);
  const isWeakSet = (v) => succeeds(WeakSet.prototype.has, v);
  const isDate = (v) => succeeds(Date.prototype.getTime, v);
  const isNumberObject = (v) => succeeds(Number.prototype.valueOf, v);
  const isStringObject = (v) => succeeds(String.prototype.valueOf, v);
  const isBooleanObject = (v) => succeeds(Boolean.prototype.valueOf, v);
  const isArrayBuffer = (v) => succeeds(arrayBufferByteLength, v);
  const isSharedArrayBuffer = (v) => sharedArrayBufferByteLength !== undefined && succeeds(sharedArrayBufferByteLength, v);

  function isRegExp(v) {
    if (v === RegExp.prototype) return false;
    return succeeds(regExpSourceGetter, v);
  }

  function isErrorInstance(v) {
    if (typeof internal.isError === "function") return !!internal.isError(v);
    if (nativeIsError) return nativeIsError(v);
    return objectToString.call(v) === "[object Error]";
  }

  function isPromise(v) {
    if (typeof internal.isPromise === "function") return !!internal.isPromise(v);
    return v instanceof Promise || objectToString.call(v) === "[object Promise]";
  }

  function isProxy(v) {
    try {
      return !!internal.isProxy(v);
    } catch {
      return false;
    }
  }

  function isNamespace(v) {
    try {
      return !!internal.isESMNamespace(v);
    } catch {
      return false;
    }
  }

  function typedArrayName(v) {
    return typedArrayTagGetter.call(v);
  }

  // JSC's `is_class`: true for `class` syntax and for native constructors
  // (Map, Array, Error, ...). Promise is a plain JSFunction in JSC.
  function isClassFunction(fn) {
    let src;
    try {
      src = functionToString.call(fn);
    } catch {
      return false;
    }
    if (/^class\b/.test(src)) return true;
    return isNativeConstructor(fn, src);
  }

  function isNativeConstructor(fn, src) {
    if (!/\{\s*\[native code\]\s*\}\s*$/.test(src)) return false;
    const name = safeGet(fn, "name");
    if (typeof name !== "string" || !/^[A-Z]/.test(name) || name === "Promise") return false;
    const desc = Object.getOwnPropertyDescriptor(fn, "prototype");
    return !!desc && typeof desc.value === "object" && desc.value !== null;
  }

  function safeGet(obj, key) {
    try {
      return obj[key];
    } catch {
      return undefined;
    }
  }

  function safeGetPrototype(obj) {
    try {
      return Object.getPrototypeOf(obj);
    } catch {
      return null;
    }
  }

  function functionName(fn) {
    const name = safeGet(fn, "name");
    if (typeof name !== "string") return "";
    // JSC reports no name for user functions keyed by a symbol ("[sym]").
    if (name.startsWith("[") && name.endsWith("]") && !isNativeFunction(fn)) return "";
    return name;
  }

  function isNativeFunction(fn) {
    try {
      return /\{\s*\[native code\]\s*\}\s*$/.test(functionToString.call(fn));
    } catch {
      return false;
    }
  }

  // Marker for accessor properties; JSC hands the formatter a GetterSetter cell.
  class Accessor {
    constructor(desc) {
      this.hasGetter = typeof desc.get === "function";
      this.hasSetter = typeof desc.set === "function";
    }
  }

  // ───────────────────────────── tags ─────────────────────────────

  // A tag result: { tag, stringLike, custom }.
  function tagOf(value, opts) {
    const disableCustom = !!(opts && opts.disableCustom);
    const hideGlobal = !!(opts && opts.hideGlobal);
    if (value === undefined) return { tag: "Undefined" };
    if (value === null) return { tag: "Null" };
    switch (typeof value) {
      case "number":
        return { tag: isInt32(value) ? "Integer" : "Double" };
      case "boolean":
        return { tag: "Boolean" };
      case "string":
        return { tag: "String", stringLike: true };
      case "symbol":
        return { tag: "Symbol" };
      case "bigint":
        return { tag: "BigInt" };
    }
    if (value instanceof Accessor) return { tag: "GetterSetter" };
    if (value === globalThis && hideGlobal) return { tag: "GlobalObject" };
    if (isProxy(value) && value !== globalThis) return proxyTag(value);
    if (!disableCustom) {
      let custom;
      try {
        custom = value[INSPECT_CUSTOM];
      } catch {
        return { tag: "RevokedProxy" };
      }
      if (typeof custom === "function") return { tag: "CustomFormattedObject", custom: { fn: custom, self: value } };
    }
    if (typeof value === "function") return { tag: isClassFunction(value) ? "Class" : "Function" };
    return objectTag(value);
  }

  function isInt32(n) {
    return (n | 0) === n && !Object.is(n, -0);
  }

  function proxyTag(value) {
    try {
      Reflect.getPrototypeOf(value);
    } catch {
      return { tag: "RevokedProxy" };
    }
    return { tag: "Proxy" };
  }

  function objectTag(value) {
    if (isErrorInstance(value)) return { tag: "Error" };
    if (Array.isArray(value)) return { tag: "Array" };
    if (ArrayBuffer.isView(value) || isArrayBuffer(value) || isSharedArrayBuffer(value)) return { tag: "TypedArray" };
    const brand = objectToString.call(value);
    if (brand === "[object Arguments]") return { tag: "Array", isArguments: true };
    if (isMap(value) || isWeakMap(value)) return { tag: "Map" };
    if (isSet(value) || isWeakSet(value)) return { tag: "Set" };
    if (isPromise(value)) return { tag: "Promise" };
    if (isDate(value)) return { tag: "Date" };
    if (isRegExp(value)) return { tag: "String", regexp: true };
    if (isStringObject(value)) return { tag: "String", stringLike: true, boxed: true };
    if (isNumberObject(value)) return { tag: "Double", boxed: true };
    if (isBooleanObject(value)) return { tag: "Boolean", boxed: true };
    if (brand === "[object Map Iterator]") return { tag: "MapIterator" };
    if (brand === "[object Set Iterator]") return { tag: "SetIterator" };
    return { tag: "Object" };
  }

  const CIRCULAR_TAGS = new Set(["Function", "Array", "Object", "Map", "Set", "Error", "Class"]);
  const PRIMITIVE_TAGS = new Set(["String", "StringPossiblyFormatted", "Undefined", "Double", "Integer", "Null", "Boolean", "Symbol", "BigInt"]);

  // ───────────────────────────── string helpers ─────────────────────────────

  function quoteJSON(str) {
    return JSON.stringify(str);
  }

  const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function hasWideChars(str) {
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0xff) return true;
    }
    return false;
  }

  function spaces(n) {
    return n > 0 ? " ".repeat(n) : "";
  }

  function formatNumber(n) {
    return Object.is(n, -0) ? "-0" : String(n);
  }

  // ───────────────────────────── class names ─────────────────────────────

  function constructorNameOf(holder) {
    let desc;
    for (let obj = holder; obj !== null; obj = safeGetPrototype(obj)) {
      try {
        desc = Object.getOwnPropertyDescriptor(obj, "constructor");
      } catch {
        return null;
      }
      if (desc) break;
    }
    if (!desc || !("value" in desc) || typeof desc.value !== "function") return null;
    return functionName(desc.value);
  }

  // JSC's getClassName: constructor display name, then Symbol.toStringTag,
  // then "Object".
  function getClassName(value) {
    let name = null;
    try {
      const own = Object.getOwnPropertyDescriptor(value, "constructor");
      if (own && "value" in own && typeof own.value === "function") name = functionName(own.value);
    } catch {
      return "Object";
    }
    if (name === null) {
      const proto = safeGetPrototype(value);
      if (proto !== null && typeof proto === "object") name = constructorNameOf(proto);
    }
    if (name !== null && name !== "Object") return name === "" ? "Object" : name;
    const tag = safeGet(value, Symbol.toStringTag);
    if (typeof tag === "string" && tag !== "") return tag;
    return "Object";
  }

  function getObjectName(value) {
    const name = getClassName(value);
    if (name !== "Object") return name;
    if (safeGetPrototype(value) === null) return "[Object: null prototype]";
    return null;
  }

  // ───────────────────────────── property enumeration ─────────────────────────────

  // Own keys in the order Bun prints them: JSC enumerates symbols
  // interleaved with strings in insertion order, while Reflect.ownKeys puts
  // all symbols last. The engine hook recovers insertion order.
  function orderedOwnKeys(obj) {
    if (typeof internal.ownKeysInOrder === "function") {
      const keys = internal.ownKeysInOrder(obj);
      if (keys) return keys;
    }
    return Reflect.ownKeys(obj);
  }

  function isIndexKey(key) {
    return typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
  }

  // Approximates JSC's canPerformFastPropertyEnumerationForIterationBun.
  function isFastEnumerable(obj) {
    if (typeof obj !== "object" && typeof obj !== "function") return false;
    if (isProxy(obj) || Array.isArray(obj) || ArrayBuffer.isView(obj)) return false;
    if (isStringObject(obj) || isNamespace(obj)) return false;
    let keys;
    try {
      keys = orderedOwnKeys(obj);
    } catch {
      return false;
    }
    for (const key of keys) {
      if (isIndexKey(key) || key === "__proto__") return false;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc && !("value" in desc)) return false;
    }
    return true;
  }

  function lookupDescriptor(object, key) {
    for (let obj = object; obj !== null && obj !== undefined; obj = safeGetPrototype(obj)) {
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(obj, key);
      } catch {
        return undefined;
      }
      if (desc) return desc;
    }
    return undefined;
  }

  function isChainStop(obj) {
    return obj === Object.prototype || obj === Function.prototype;
  }

  // Port of JSC__JSValue__forEachPropertyImpl. Calls cb(key, value) where
  // accessors arrive as Accessor markers.
  function forEachProperty(object, nonIndexedOnly, cb) {
    const visited = new Set();
    let protoCount = 0;
    let target = object;
    let fast = !nonIndexedOnly && isFastEnumerable(object);
    if (fast && orderedOwnKeys(object).length === 0) {
      fast = false;
      const proto = safeGetPrototype(object);
      if (proto) {
        target = proto;
        fast = isFastEnumerable(proto);
        protoCount = 1;
      }
    }
    while (fast) {
      const anyHits = fastPass(object, target, visited, cb);
      if (!anyHits) break;
      if (protoCount++ >= 5) return;
      const proto = safeGetPrototype(target);
      if (!proto || isChainStop(proto)) return;
      target = proto;
      fast = isFastEnumerable(proto);
    }
    slowPass(object, target, protoCount, nonIndexedOnly, visited, cb);
  }

  function fastPass(object, target, visited, cb) {
    let anyHits = false;
    const entries = [];
    for (const key of orderedOwnKeys(target)) {
      if (key === "constructor" || key === "__proto__" || key === Symbol.toStringTag) continue;
      if (target !== object && key === "__esModule") continue;
      if (visited.has(key)) continue;
      visited.add(key);
      entries.push(key);
    }
    for (const key of entries) {
      const value = target === object ? Object.getOwnPropertyDescriptor(target, key).value : safeGet(target, key);
      anyHits = true;
      cb(key, value);
    }
    return anyHits;
  }

  function slowPass(object, start, protoCount, nonIndexedOnly, visited, cb) {
    let iterating = start;
    while (iterating && !isChainStop(iterating) && protoCount++ < 5) {
      for (const key of ownKeysFor(iterating, nonIndexedOnly)) {
        visitSlowKey(object, key, nonIndexedOnly, visited, cb);
      }
      if (nonIndexedOnly) break;
      if (typeof iterating === "function" || iterating === globalThis) break;
      iterating = safeGetPrototype(iterating);
    }
  }

  function ownKeysFor(obj, nonIndexedOnly) {
    let keys;
    try {
      // JSC's slow path enumerates like Reflect.ownKeys (symbols last).
      keys = Reflect.ownKeys(obj);
    } catch {
      return [];
    }
    return nonIndexedOnly ? keys.filter((key) => !isIndexKey(key)) : keys;
  }

  function visitSlowKey(object, key, nonIndexedOnly, visited, cb) {
    if (key === "constructor") return;
    if (nonIndexedOnly && key === "length") return;
    const desc = lookupDescriptor(object, key);
    if (!desc) return;
    if (!desc.enumerable && (key === "__proto__" || key === Symbol.toStringTag || key === "__esModule")) return;
    if (visited.has(key)) return;
    visited.add(key);
    cb(key, "value" in desc ? desc.value : new Accessor(desc));
  }

  function codePointCompare(a, b) {
    const ai = Array.from(a, (c) => c.codePointAt(0));
    const bi = Array.from(b, (c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
      if (ai[i] !== bi[i]) return ai[i] - bi[i];
    }
    return ai.length - bi.length;
  }

  function keySortString(key) {
    return typeof key === "symbol" ? key.description || "" : key;
  }

  // Port of JSC__JSValue__forEachPropertyOrdered (own properties only, sorted).
  function forEachPropertyOrdered(object, cb) {
    const keys = ownKeysFor(object, false);
    keys.sort((a, b) => codePointCompare(keySortString(a), keySortString(b)));
    for (const key of keys) {
      if (key === "constructor") continue;
      const desc = lookupDescriptor(object, key);
      if (!desc) continue;
      if (!desc.enumerable && (key === "__proto__" || key === Symbol.toStringTag)) continue;
      cb(key, "value" in desc ? desc.value : new Accessor(desc));
    }
  }

  // ───────────────────────────── formatter ─────────────────────────────

  // Module-wide equivalent of VirtualMachine.had_errors.
  let hadErrors = false;

  class Formatter {
    constructor(options) {
      this.out = "";
      this.indent = 0;
      this.depth = 0;
      this.maxDepth = options.maxDepth;
      this.outerMaxDepth = undefined;
      this.quoteStrings = !!options.quoteStrings;
      this.quoteKeys = false;
      this.estimatedLineLength = 0;
      this.alwaysNewlineScope = false;
      this.singleLine = !!options.singleLine;
      this.orderedProperties = !!options.orderedProperties;
      this.disableInspectCustom = false;
      this.formatBufferAsText = false;
      this.remaining = [];
      this.visited = new Set();
      this.customFormatted = null;
    }

    write(s) {
      this.out += s;
    }

    addForNewLine(n) {
      this.estimatedLineLength += n;
    }

    resetLine() {
      this.estimatedLineLength = this.indent * 2;
    }

    goodTimeForANewLine() {
      if (this.estimatedLineLength > 80) {
        this.resetLine();
        return true;
      }
      return false;
    }

    printComma() {
      this.write(",");
      this.estimatedLineLength += 1;
    }

    space() {
      this.estimatedLineLength += 1;
      this.write(" ");
    }

    writeIndent() {
      this.write(spaces(this.indent * 2));
    }

    tagOpts() {
      return { hideGlobal: true, disableCustom: this.disableInspectCustom };
    }

    errorChainMaxDepth() {
      return this.outerMaxDepth !== undefined ? this.outerMaxDepth : this.maxDepth;
    }

    format(tagResult, value) {
      if (tagResult.tag === "CustomFormattedObject") this.customFormatted = tagResult.custom;
      this.printAs(tagResult.tag, value, tagResult);
    }

    formatValue(value) {
      this.format(tagOf(value, this.tagOpts()), value);
    }

    printAs(tag, value, tagResult) {
      const info = tagResult || {};
      if (!CIRCULAR_TAGS.has(tag)) {
        this.dispatch(tag, value, info);
        return;
      }
      if (this.visited.has(value)) {
        this.write("[Circular]");
        return;
      }
      this.visited.add(value);
      try {
        this.dispatch(tag, value, info);
      } finally {
        this.visited.delete(value);
      }
    }

    dispatch(tag, value, info) {
      switch (tag) {
        case "StringPossiblyFormatted":
          return this.printStringPossiblyFormatted(value);
        case "String":
          return this.printString(value, info);
        case "Integer":
        case "Double":
          return this.printNumber(value, info);
        case "BigInt":
          return this.printBigInt(value);
        case "Undefined":
          this.addForNewLine(9);
          return this.write("undefined");
        case "Null":
          this.addForNewLine(4);
          return this.write("null");
        case "Boolean":
          return this.printBoolean(value, info);
        case "Symbol":
          return this.printSymbol(value);
        case "CustomFormattedObject":
          return this.printCustomFormatted();
        case "Error":
          return this.printError(value);
        case "Class":
          return this.printClass(value);
        case "Function":
          return this.printFunction(value);
        case "GetterSetter":
          return this.printGetterSetter(value);
        case "Array":
          return this.printArray(value, info);
        case "Promise":
          return this.printPromise(value);
        case "GlobalObject":
          this.addForNewLine(15);
          return this.write("[Global Object]");
        case "Map":
          return this.printMap(value);
        case "Set":
          return this.printSet(value);
        case "MapIterator":
          return this.printIterator(value, "MapIterator");
        case "SetIterator":
          return this.printIterator(value, "SetIterator");
        case "Date":
          return this.printDate(value);
        case "TypedArray":
          return this.printTypedArray(value);
        case "RevokedProxy":
          this.addForNewLine(15);
          return this.write("<Revoked Proxy>");
        case "Proxy":
          return this.printProxy(value);
        default:
          return this.printObject(value);
      }
    }

    // ── primitives ──

    printStringPossiblyFormatted(value) {
      const str = String(value);
      this.addForNewLine(str.length);
      this.writeWithFormatting(str);
    }

    printString(value, info) {
      // Reached from `%s` too, so `value` may be anything.
      const str = typeof value === "symbol" ? value.toString() : String(value);
      this.addForNewLine(str.length);
      if (this.quoteStrings && !info.regexp) {
        this.write(str.length === 0 ? '""' : quoteJSON(str));
        return;
      }
      if (info.boxed) {
        this.write("[String: " + quoteJSON(str) + "]");
        return;
      }
      this.write(str);
    }

    printNumber(value, info) {
      if (info.boxed) {
        const name = getClassName(value);
        const num = String(Number.prototype.valueOf.call(value));
        if (name !== "Number") {
          this.addForNewLine(name.length + num.length + 11);
          this.write("[Number (" + name + "): " + num + "]");
          return;
        }
        this.addForNewLine(name.length + num.length + 4);
        this.write("[" + name + ": " + num + "]");
        return;
      }
      const text = formatNumber(value);
      this.addForNewLine(text.length);
      this.write(text);
    }

    printBigInt(value) {
      const text = value.toString();
      this.addForNewLine(text.length);
      this.write(text + "n");
    }

    printBoolean(value, info) {
      if (info.boxed) {
        const name = getClassName(value);
        const text = String(Boolean.prototype.valueOf.call(value));
        if (name !== "Boolean") {
          this.addForNewLine(text.length + name.length + 14);
          this.write("[Boolean (" + name + "): " + text + "]");
          return;
        }
        this.addForNewLine(text.length + 11);
        this.write("[Boolean: " + text + "]");
        return;
      }
      this.addForNewLine(value ? 4 : 5);
      this.write(value ? "true" : "false");
    }

    printSymbol(value) {
      const description = value.description;
      this.addForNewLine(6);
      if (description) {
        this.addForNewLine(description.length + 2);
        this.write("Symbol(" + description + ")");
        return;
      }
      this.write("Symbol()");
    }

    printDate(value) {
      let text;
      try {
        text = JSON.stringify(Date.prototype.toISOString.call(value));
      } catch {
        text = "null";
      }
      this.addForNewLine(text.length);
      this.write(text === "null" ? "Invalid Date" : text.slice(1, -1));
    }

    // ── custom inspect / proxy ──

    printCustomFormatted() {
      const { fn, self } = this.customFormatted;
      const depthArg = Math.max(0, this.maxDepth - this.depth);
      const options = { depth: this.maxDepth, colors: false, showHidden: false, stylize: (s) => String(s) };
      const result = fn.call(self, depthArg, options, nodeInspectForCustom);
      if (typeof result === "string") {
        this.write(result);
        return;
      }
      const opts = { hideGlobal: false, disableCustom: result === self };
      this.format(tagOf(result, opts), result);
    }

    printProxy(value) {
      let target = value;
      if (typeof internal.getProxyTarget === "function") target = internal.getProxyTarget(value);
      // Without a target hook the proxy is formatted through its traps.
      const tag = target === value ? objectTagThroughProxy(value) : tagOf(target);
      this.format(tag, target);
    }

    // ── functions and classes ──

    printClass(value) {
      const printable = functionName(value);
      this.addForNewLine(printable.length);
      const proto = safeGetPrototype(value);
      const protoIsClass = typeof proto === "function" && isClassFunction(proto);
      const protoName = protoIsClass ? functionName(proto) : "";
      this.addForNewLine(protoName.length);
      const base = printable === "" ? "(anonymous)" : printable;
      this.write(protoName === "" ? "[class " + base + "]" : "[class " + base + " extends " + protoName + "]");
    }

    printFunction(value) {
      const printable = functionName(value);
      const funcName = functionKindName(value);
      if (printable === "" || funcName === printable) {
        this.write(funcName === "" ? "[Function]" : "[" + funcName + "]");
        return;
      }
      this.write("[" + (funcName === "" ? "Function" : funcName) + ": " + printable + "]");
    }

    printGetterSetter(value) {
      if (value.hasGetter && value.hasSetter) return this.write("[Getter/Setter]");
      if (value.hasGetter) return this.write("[Getter]");
      if (value.hasSetter) return this.write("[Setter]");
    }

    printPromise(value) {
      if (!this.singleLine && this.goodTimeForANewLine()) {
        this.write("\n");
        this.writeIndent();
      }
      const state = internal.promiseState(value);
      const label = state === "pending" ? "<pending>" : state === "rejected" ? "<rejected>" : "<resolved>";
      this.write("Promise { " + label + " }");
    }

    // ── arrays ──

    printArray(value, info) {
      const len = Number(value.length) || 0;
      if (len === 0) {
        this.write("[]");
        this.addForNewLine(2);
        return;
      }
      const state = { wasGoodTime: this.alwaysNewlineScope || len > 10 };
      this.indent += 1;
      this.depth += 1;
      const prevQuote = this.quoteStrings;
      this.quoteStrings = true;
      try {
        this.printArrayBody(value, len, state, info);
      } finally {
        this.quoteStrings = prevQuote;
        this.depth -= 1;
        this.indent -= 1;
      }
      this.printArrayClose(state);
    }

    printArrayBody(value, len, state, info) {
      this.addForNewLine(2);
      const holes = new HoleScanner(value, len, !info.isArguments);
      let emptyStart = this.printFirstArrayElement(value, state, holes);
      let i = 1;
      let nonemptyCount = 1;
      while (i < len) {
        if (!holes.has(i)) {
          if (emptyStart === null) emptyStart = i;
          const next = holes.nextPresent(i + 1);
          if (next === -1 || next >= len) break;
          i = next;
          continue;
        }
        if (nonemptyCount >= 100) {
          this.printComma();
          this.write("\n");
          this.estimatedLineLength = 0;
          this.writeIndent();
          this.addForNewLine(16);
          this.write("... " + (len - i) + " more items");
          break;
        }
        nonemptyCount += 1;
        if (emptyStart !== null) {
          this.printEmptyRun(emptyStart, i - emptyStart, state);
          emptyStart = null;
        }
        this.printComma();
        this.arraySeparator(state);
        const element = value[i];
        this.format(tagOf(element, this.tagOpts()), element);
        i += 1;
      }
      if (emptyStart !== null) this.printEmptyRun(emptyStart, len - emptyStart, state);
      if (!info.isArguments) this.printArrayExtraProperties(value, i);
    }

    printFirstArrayElement(value, state, holes) {
      const present = holes.has(0);
      const element = present ? value[0] : undefined;
      const tag = tagOf(element, this.tagOpts());
      state.wasGoodTime = state.wasGoodTime || !PRIMITIVE_TAGS.has(tag.tag) || this.goodTimeForANewLine();
      if (!this.singleLine && (this.orderedProperties || state.wasGoodTime)) {
        this.resetLine();
        this.write("[\n");
        this.writeIndent();
        this.addForNewLine(1);
      } else {
        this.write("[ ");
        this.addForNewLine(2);
      }
      if (!present) return 0;
      this.format(tag, element);
      return null;
    }

    arraySeparator(state) {
      if (!this.singleLine && (this.orderedProperties || this.goodTimeForANewLine())) {
        this.write("\n");
        state.wasGoodTime = true;
        this.writeIndent();
        return;
      }
      this.space();
    }

    printEmptyRun(start, count, state) {
      if (start > 0) {
        this.printComma();
        this.arraySeparator(state);
      }
      if (count === 1) {
        this.addForNewLine(10);
        this.write("empty item");
        return;
      }
      this.addForNewLine(String(count).length + 14);
      this.write(count + " x empty items");
    }

    printArrayExtraProperties(value, count) {
      const ctx = {
        i: count,
        singleLine: this.singleLine,
        alwaysNewline: !this.singleLine && (this.alwaysNewlineScope || this.goodTimeForANewLine()),
        parent: value,
      };
      forEachProperty(value, true, (key, v) => this.printProperty(ctx, key, v));
    }

    printArrayClose(state) {
      if (!this.singleLine && (this.orderedProperties || state.wasGoodTime || this.goodTimeForANewLine())) {
        this.resetLine();
        this.write("\n");
        this.writeIndent();
        this.write("]");
        this.resetLine();
        this.addForNewLine(1);
        return;
      }
      this.write(" ]");
      this.addForNewLine(2);
    }

    // ── maps, sets, iterators ──

    printMap(value) {
      const length = Number(safeGet(value, "size")) | 0;
      const name = isWeakMap(value) ? "WeakMap" : "Map";
      if (length === 0) {
        this.write(name + " {}");
        return;
      }
      const prevQuote = this.quoteStrings;
      this.quoteStrings = true;
      this.write(this.singleLine ? name + "(" + length + ") { " : name + "(" + length + ") {\n");
      this.indent += 1;
      this.depth += 1;
      try {
        this.printMapEntries(value);
      } finally {
        this.indent -= 1;
        this.depth -= 1;
        this.quoteStrings = prevQuote;
      }
      if (!this.singleLine) this.writeIndent();
      this.write("}");
    }

    printMapEntries(value) {
      let count = 0;
      for (const [key, val] of Map.prototype.entries.call(value)) {
        if (this.singleLine && count > 0) {
          this.printComma();
          this.write(" ");
        }
        if (!this.singleLine) this.writeIndent();
        this.formatValue(key);
        this.write(": ");
        this.formatValue(val);
        count += 1;
        if (!this.singleLine) {
          this.printComma();
          this.write("\n");
        }
      }
      if (this.singleLine && count > 0) this.write(" ");
    }

    printSet(value) {
      const length = Number(safeGet(value, "size")) | 0;
      const name = isWeakSet(value) ? "WeakSet" : "Set";
      if (length === 0) {
        this.write(name + " {}");
        return;
      }
      const prevQuote = this.quoteStrings;
      this.quoteStrings = true;
      this.write(this.singleLine ? name + "(" + length + ") { " : name + "(" + length + ") {\n");
      this.indent += 1;
      this.depth += 1;
      try {
        this.printSetEntries(value);
      } finally {
        this.indent -= 1;
        this.depth -= 1;
        this.quoteStrings = prevQuote;
      }
      if (!this.singleLine) this.writeIndent();
      this.write("}");
    }

    printSetEntries(value) {
      let first = true;
      for (const item of Set.prototype.values.call(value)) {
        if (this.singleLine && !first) {
          this.printComma();
          this.write(" ");
        }
        first = false;
        if (!this.singleLine) this.writeIndent();
        this.formatValue(item);
        if (!this.singleLine) {
          this.printComma();
          this.write("\n");
        }
      }
      if (this.singleLine && !first) this.write(" ");
    }

    printIterator(value, label) {
      const prevQuote = this.quoteStrings;
      this.quoteStrings = true;
      this.write(label + " { ");
      this.indent += 1;
      this.depth += 1;
      let count = 0;
      try {
        count = this.printIteratorEntries(iteratorEntries(value));
      } finally {
        this.indent -= 1;
        this.depth -= 1;
        this.quoteStrings = prevQuote;
      }
      if (this.singleLine && count > 0 && label === "MapIterator") this.write(" ");
      if (!this.singleLine && count > 0) this.write("\n");
      if (!this.singleLine) this.writeIndent();
      this.write("}");
    }

    printIteratorEntries(entries) {
      let count = 0;
      for (const entry of entries) {
        if (this.singleLine && count > 0) {
          this.printComma();
          this.write(" ");
        }
        if (!this.singleLine) {
          this.write("\n");
          this.writeIndent();
        }
        this.formatValue(entry);
        count += 1;
        if (!this.singleLine) this.printComma();
      }
      return count;
    }

    // ── typed arrays ──

    printTypedArray(value) {
      const view = typedArrayView(value);
      const text = this.formatBufferAsText && view.name === "Uint8Array" ? decodeUtf8Strict(view.bytes) : null;
      if (text !== null) {
        this.write(quoteJSON(text));
        return;
      }
      if (view.isBuffer) {
        this.write(formatBufferLikeNode(view.bytes));
        return;
      }
      this.write(view.name);
      if (view.length === 0) {
        this.write("(" + view.length + ") []");
        return;
      }
      this.write("(" + view.length + ") [ ");
      this.writeTypedArrayElements(view);
      this.write(" ]");
    }

    writeTypedArrayElements(view) {
      const suffix = view.isBigInt ? "n" : "";
      const MAX = 512;
      const shown = Math.min(view.length, MAX + 1);
      this.write(formatTypedElement(view.elements[0]) + suffix);
      for (let i = 1; i < shown; i++) {
        this.printComma();
        this.space();
        this.write(formatTypedElement(view.elements[i]) + suffix);
      }
      if (view.length > MAX + 1) this.write(suffix + ", ... " + (view.length - MAX - 1) + " more");
    }

    // ── objects ──

    printObject(value) {
      const prevQuote = this.quoteStrings;
      this.quoteStrings = true;
      const prevScope = this.alwaysNewlineScope;
      try {
        this.printObjectInner(value);
      } finally {
        this.quoteStrings = prevQuote;
        this.alwaysNewlineScope = prevScope;
      }
    }

    printObjectInner(value) {
      const alwaysNewline = !this.singleLine && (this.alwaysNewlineScope || this.goodTimeForANewLine());
      if (this.depth > this.maxDepth) {
        this.printObjectDepthExceeded();
        return;
      }
      const ctx = { i: 0, singleLine: this.singleLine, alwaysNewline, parent: value };
      const cb = (key, v) => this.printProperty(ctx, key, v);
      if (this.orderedProperties) {
        forEachPropertyOrdered(value, cb);
      } else {
        forEachProperty(value, false, cb);
      }
      this.printObjectTail(value, ctx);
    }

    printObjectDepthExceeded() {
      if (this.singleLine) {
        this.write(" ");
      } else if (this.alwaysNewlineScope || this.goodTimeForANewLine()) {
        this.write("\n");
        this.writeIndent();
        this.resetLine();
      }
      this.write("[Object ...]");
    }

    printObjectTail(value, ctx) {
      if (ctx.i === 0) {
        if (typeof value === "function") {
          this.printAs(isClassFunction(value) ? "Class" : "Function", value);
          return;
        }
        const name = getObjectName(value);
        if (name !== null) this.write(name + " ");
        this.write("{}");
        return;
      }
      this.depth -= 1;
      if (ctx.alwaysNewline) {
        this.indent = Math.max(0, this.indent - 1);
        this.printComma();
        this.write("\n");
        this.writeIndent();
        this.write("}");
        this.estimatedLineLength += 1;
        return;
      }
      this.estimatedLineLength += 2;
      this.write(" }");
    }

    // PropertyIteratorCtx::for_each
    printProperty(ctx, key, value) {
      if (key === "constructor") return;
      const tag = tagOf(value, this.tagOpts());
      if (ctx.i === 0) this.handleFirstProperty(ctx);
      if (ctx.i > 0) this.printComma();
      const before = ctx.i;
      ctx.i += 1;
      if (before > 0) this.propertySeparator(ctx);
      this.writePropertyKey(key);
      this.format(tag, value);
    }

    handleFirstProperty(ctx) {
      if (typeof ctx.parent !== "function") {
        const name = getObjectName(ctx.parent);
        if (name !== null) this.write(name + " ");
      }
      if (!ctx.singleLine) ctx.alwaysNewline = true;
      this.estimatedLineLength = this.indent * 2 + 1;
      this.indent += 1;
      this.depth += 1;
      if (ctx.singleLine) {
        this.write("{ ");
        return;
      }
      this.write("{\n");
      this.writeIndent();
    }

    propertySeparator(ctx) {
      if (!this.singleLine && (ctx.alwaysNewline || this.alwaysNewlineScope || this.goodTimeForANewLine())) {
        this.write("\n");
        this.writeIndent();
        this.resetLine();
        return;
      }
      this.space();
    }

    writePropertyKey(key) {
      if (typeof key === "symbol") {
        const desc = key.description || "";
        this.addForNewLine(12 + desc.length);
        this.write("[Symbol(" + desc + ")]: ");
        return;
      }
      if (!this.quoteKeys && IDENT_RE.test(key)) {
        this.addForNewLine(key.length + 1);
        this.write(key + ": ");
        return;
      }
      this.addForNewLine(key.length + 2);
      // Bun writes 16-bit keys between quotes without escaping them.
      this.write(hasWideChars(key) ? '"' + key + '": ' : quoteJSON(key) + ": ");
    }

    // ── printf-style formatting ──

    writeWithFormatting(input) {
      let slice = input;
      let i = 0;
      while (i < slice.length) {
        if (slice[i] !== "%") {
          i += 1;
          continue;
        }
        i += 1;
        if (i >= slice.length || this.remaining.length === 0) break;
        const token = slice[i];
        if (token === "%") {
          this.write(slice.slice(0, i));
          slice = slice.slice(i + 1);
          i = 1;
          continue;
        }
        if (!"sfoOdicj".includes(token)) {
          i += 1;
          continue;
        }
        this.write(slice.slice(0, i - 1));
        slice = slice.slice(i + 1);
        i = 0;
        this.writeSubstitution(token, this.remaining.shift());
        if (this.remaining.length === 0) break;
      }
      if (slice.length > 0) this.write(slice);
    }

    writeSubstitution(token, value) {
      switch (token) {
        case "s":
          return this.printAs("String", value, {});
        case "d":
        case "i":
          return this.writeIntegerSubstitution(value);
        case "f":
          return this.writeFloatSubstitution(value);
        case "o":
        case "O":
          return this.format(tagOf(value), value);
        case "c":
          return;
        case "j": {
          const json = JSON.stringify(value);
          const text = json === undefined ? "" : json;
          this.addForNewLine(text.length);
          return this.write(text);
        }
      }
    }

    writeIntegerSubstitution(value) {
      const int = percentInteger(value);
      const text = Number.isNaN(int) ? "NaN" : String(int);
      this.addForNewLine(text.length);
      this.write(text);
    }

    writeFloatSubstitution(value) {
      let converted;
      if (typeof value === "symbol") {
        converted = NaN;
      } else {
        converted = toNumberLoose(value);
      }
      const text = formatNumber(converted);
      this.addForNewLine(text.length);
      this.write(text);
    }
  }

  function toNumberLoose(value) {
    try {
      return Number(value);
    } catch {
      return NaN;
    }
  }

  // Mirrors Bun's parseInt emulation for %d / %i.
  function percentInteger(value) {
    if (typeof value === "symbol") return NaN;
    let num = toNumberLoose(value);
    if (!Number.isFinite(num)) return NaN;
    if (num === 0) return 0;
    const sign = num < 0 ? -1 : 1;
    num = Math.abs(num);
    if (num >= 1e21) {
      while (num >= 10) num /= 10;
    } else if (num < 0.000001) {
      while (num < 1) num *= 10;
    }
    return Math.floor(num) * sign;
  }

  // When a proxy's target is unavailable, tag it from what its traps report.
  function objectTagThroughProxy(value) {
    if (typeof value === "function") return { tag: isClassFunction(value) ? "Class" : "Function" };
    if (Array.isArray(value)) return { tag: "Array" };
    return { tag: "Object" };
  }

  function functionKindName(fn) {
    const proto = safeGetPrototype(fn);
    if (proto === null || proto === undefined || proto === Function.prototype) return "";
    const name = constructorNameOf(proto);
    return name === null || name === "Function" ? "" : name;
  }

  // Tracks holes in arrays without probing every index of huge sparse arrays.
  class HoleScanner {
    constructor(value, len, isArray) {
      this.value = value;
      this.len = len;
      this.isArray = isArray;
      this.presentIndices = null;
    }

    has(i) {
      return hasOwn.call(this.value, i);
    }

    nextPresent(from) {
      if (!this.isArray) return from;
      if (this.presentIndices === null) {
        this.presentIndices = Object.keys(this.value)
          .filter(isIndexKey)
          .map(Number);
      }
      for (const index of this.presentIndices) {
        if (index >= from) return index;
      }
      return -1;
    }
  }

  function iteratorEntries(it) {
    if (typeof internal.iteratorEntries !== "function") return [];
    try {
      return internal.iteratorEntries(it) || [];
    } catch {
      return [];
    }
  }

  function typedArrayView(value) {
    if (isArrayBuffer(value) || isSharedArrayBuffer(value)) {
      const bytes = new Uint8Array(value);
      const name = isSharedArrayBuffer(value) ? "SharedArrayBuffer" : "ArrayBuffer";
      return { name, length: bytes.length, elements: bytes, bytes, isBigInt: false, isBuffer: false };
    }
    const name = typedArrayName(value);
    if (name === undefined) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { name: "DataView", length: bytes.length, elements: bytes, bytes, isBigInt: false, isBuffer: false };
    }
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const isBigInt = name === "BigInt64Array" || name === "BigUint64Array";
    const isBuffer = name === "Uint8Array" && isBufferInstance(value);
    return { name, length: value.length, elements: value, bytes, isBigInt, isBuffer };
  }

  function isBufferInstance(value) {
    const ctor = safeGet(value, "constructor");
    return typeof ctor === "function" && functionName(ctor) === "Buffer";
  }

  // Node's Buffer.prototype[inspect.custom], which Bun inherits.
  function formatBufferLikeNode(bytes) {
    const max = 50;
    const shown = Array.from(bytes.subarray(0, max), (b) => b.toString(16).padStart(2, "0")).join(" ");
    const extra = bytes.length > max ? " ... " + (bytes.length - max) + " more byte" + (bytes.length - max > 1 ? "s" : "") : "";
    return "<Buffer" + (shown ? " " + shown : "") + extra + ">";
  }

  function formatTypedElement(n) {
    return String(n);
  }

  // Strict UTF-8 decode without TextDecoder (not part of ECMAScript).
  // Returns null for malformed input.
  function decodeUtf8Strict(bytes) {
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const cp = decodeCodePoint(bytes, i);
      if (cp === null) return null;
      out += String.fromCodePoint(cp.value);
      i += cp.size;
    }
    return out;
  }

  function decodeCodePoint(bytes, i) {
    const b0 = bytes[i];
    if (b0 < 0x80) return { value: b0, size: 1 };
    const size = b0 >= 0xf0 && b0 <= 0xf4 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc2 && b0 < 0xe0 ? 2 : 0;
    if (size === 0 || i + size > bytes.length || b0 > 0xf4) return null;
    let value = b0 & (0xff >> (size + 1));
    for (let k = 1; k < size; k++) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) return null;
      value = (value << 6) | (b & 0x3f);
    }
    const min = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000;
    if (value < min || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null;
    return { value, size };
  }

  // ───────────────────────────── errors ─────────────────────────────

  // Parses QuickJS-ng (and V8/JSC-style) `err.stack` text into frames:
  //   "    at inner (/index.js:2:10)"   -> { name: "inner", file, line, column }
  //   "    at <anonymous> (/index.js:4:11)" -> { name: "<anonymous>", ... }
  //   "    at /index.js:4:11"           -> { name: "", ... }
  //   "    at map (native)"             -> skipped
  function parseStack(stack) {
    if (typeof stack !== "string") return [];
    const frames = [];
    for (const raw of stack.split("\n")) {
      const frame = parseFrameLine(raw.trim());
      if (frame) frames.push(frame);
    }
    return frames;
  }

  // JSC (without Bun's position remapping) reports a call at its open paren;
  // Bun prints the callee, i.e. the last identifier before it.
  function calleeColumn(file, lineNo, column) {
    if (typeof internal.getSourceLine !== "function") return column;
    const text = internal.getSourceLine(file, lineNo);
    if (typeof text !== "string" || text[column - 1] !== "(") return column;
    let start = column - 1;
    while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
    return start < column - 1 ? start + 1 : column;
  }

  // JavaScriptCore frames: `name@file:line:col`, `module code@…`,
  // `forEach@[native code]`. Positions are in evaluated code; map them back.
  function parseJscFrameLine(line) {
    const m = /^(.*?)@(.*):(\d+):(\d+)$/.exec(line);
    if (!m || m[2].startsWith("bun-wasm:")) return null;
    const url = typeof internal.displayName === "function" ? internal.displayName(m[2]) : m[2];
    let [file, lineNo, column] = [url, Number(m[3]), Number(m[4])];
    const mapped = typeof internal.mapPosition === "function" ? internal.mapPosition(file, lineNo, column) : undefined;
    if (mapped) [lineNo, column] = mapped;
    column = calleeColumn(file, lineNo, column);
    const topLevel = m[1] === "global code" || m[1] === "module code" || m[1] === "eval code" || m[1] === "__bunwasm_cjs__";
    return { name: topLevel ? "" : m[1] || "<anonymous>", file, line: lineNo, column };
  }

  function parseFrameLine(line) {
    if (!line.startsWith("at ")) return line.includes("@") ? parseJscFrameLine(line) : null;
    const body = line.slice(3);
    const withName = /^(.*?) \((.*)\)$/.exec(body);
    const name = withName ? withName[1] : "";
    const location = withName ? withName[2] : body;
    const pos = /^(.*):(\d+):(\d+)$/.exec(location);
    if (!pos || pos[1].startsWith("bun-wasm:")) return null;
    // The runtime prints module/script top-level frames bare (no name), like
    // JSC; a remaining "<anonymous>" is an anonymous function and stays.
    const cleanName = name === "<eval>" ? "" : name;
    return { name: cleanName, file: pos[1], line: Number(pos[2]), column: Number(pos[3]) };
  }

  function digitCount(n) {
    return String(Math.max(0, Math.floor(n))).length;
  }

  // Source excerpt: up to 6 lines ending at the error line, then a caret.
  function sourceExcerpt(frame) {
    if (!frame || typeof internal.getSourceLine !== "function") return null;
    const lines = [];
    for (let n = Math.max(1, frame.line - 5); n <= frame.line; n++) {
      let text;
      try {
        text = internal.getSourceLine(frame.file, n);
      } catch {
        text = undefined;
      }
      if (typeof text !== "string") {
        if (n === frame.line) return null;
        continue;
      }
      lines.push({ n, text: text.replace(/[\r\n]+$/, "").replace(/\s+$/, "") });
    }
    return lines.length ? lines : null;
  }

  function writeExcerpt(f, lines, frame) {
    const pad = digitCount(lines[lines.length - 1].n);
    for (const { n, text } of lines.slice(0, -1)) {
      f.write(spaces(pad - digitCount(n)) + n + " | " + text.slice(0, 1024) + "\n");
    }
    const last = lines[lines.length - 1];
    if (last.text.length === 0) return false;
    const clamped = last.text.slice(0, 1024);
    f.write(spaces(pad - digitCount(last.n)) + last.n + " | " + clamped + "\n");
    if (clamped.length !== last.text.length) {
      f.write("\n");
      return true;
    }
    const col = Math.max(0, frame.column - 1);
    if (clamped.length < 512 || col > 512) {
      f.write(spaces(pad + 3 + col) + "^\n");
    } else {
      f.write("\n");
    }
    return true;
  }

  function errorNameAndMessage(name, message, code) {
    if (name !== "" && message !== "") {
      if (name !== "Error") return name + ": " + message + "\n";
      const prefixed = code !== undefined && message.length > code.length + 3 && message.startsWith(code + ": ");
      if (prefixed) return code + ": " + message.slice(code.length + 2) + "\n";
      return "error: " + message + "\n";
    }
    if (name !== "") return name + ": \n";
    if (message !== "") return "error: " + message + "\n";
    return "error\n";
  }

  function stringProp(err, key) {
    const v = safeGet(err, key);
    if (v === undefined || v === null) return "";
    try {
      return String(v);
    } catch {
      return "";
    }
  }

  function formatFrame(frame) {
    const loc = frame.file + ":" + frame.line + ":" + frame.column;
    return frame.name ? "      at " + frame.name + " (" + loc + ")\n" : "      at " + loc + "\n";
  }

  // VirtualMachine::print_errorlike_object, writing into the formatter.
  function printErrorLike(f, value) {
    const errors = isAggregateError(value) ? safeGet(value, "errors") : undefined;
    if (!Array.isArray(errors)) {
      printErrorInstance(f, value);
      return;
    }
    if (f.depth + 1 > f.errorChainMaxDepth()) printErrorInstance(f, value);
    for (const member of errors) {
      if (isErrorInstance(member)) printErrorInstance(f, member);
    }
  }

  function isAggregateError(value) {
    return typeof AggregateError === "function" && value instanceof AggregateError;
  }

  // VirtualMachine::print_error_instance_body for Error instances.
  function printErrorInstance(f, err) {
    const prevHadErrors = hadErrors;
    hadErrors = true;
    try {
      printErrorBody(f, err, prevHadErrors);
    } finally {
      hadErrors = prevHadErrors;
    }
  }

  function errorCode(err) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(err, "code");
    } catch {
      return undefined;
    }
    if (!desc || typeof desc.value !== "string" || /[^\x00-\xff]/.test(desc.value)) return undefined;
    return desc.value;
  }

  function printErrorBody(f, err, prevHadErrors) {
    const frames = parseStack(safeGet(err, "stack"));
    const top = frames[0];
    const name = stringProp(err, "name");
    const message = stringProp(err, "message");
    const code = errorCode(err);
    const lines = sourceExcerpt(top);
    if (lines !== null) writeExcerpt(f, lines, top);
    f.write(errorNameAndMessage(name, message, code));

    const toAppend = printErrorProperties(f, err, code, prevHadErrors);
    for (const frame of frames) f.write(formatFrame(frame));
    printAppendedErrors(f, toAppend);
  }

  // Own enumerable non-index properties (strings, then symbols).
  function errorPropertyKeys(err) {
    let keys;
    try {
      keys = orderedOwnKeys(err);
    } catch {
      return [];
    }
    return keys.filter((key) => {
      if (typeof key === "string" && (key === "" || isIndexKey(key))) return false;
      const desc = Object.getOwnPropertyDescriptor(err, key);
      return !!desc && desc.enumerable;
    });
  }

  function keyText(key) {
    return typeof key === "symbol" ? key.description || "" : key;
  }

  function printErrorProperties(f, err, code, prevHadErrors) {
    const keys = errorPropertyKeys(err);
    const longest = Math.min(10, keys.reduce((m, k) => Math.max(m, keyText(k).length), 0));
    const toAppend = [];
    let sawCause = false;
    let printedAny = false;
    for (const key of keys) {
      if (key === "message" || key === "name" || key === "stack") continue;
      if (key === "code" && code !== undefined) continue;
      const value = safeGet(err, key);
      if (isObjectLike(value) && isErrorInstance(value) && !prevHadErrors) {
        if (key === "cause") sawCause = true;
        toAppend.push(value);
        continue;
      }
      printedAny = true;
      printErrorProperty(f, key, value, longest);
    }
    if (code !== undefined) {
      printedAny = true;
      f.write(spaces(longest - 4) + " code: " + quoteJSON(code) + "\n");
    }
    if (printedAny) f.write("\n");
    if (!sawCause) appendOwnCause(err, toAppend);
    return toAppend;
  }

  function appendOwnCause(err, toAppend) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(err, "cause");
    } catch {
      return;
    }
    if (desc && "value" in desc && isObjectLike(desc.value) && isErrorInstance(desc.value)) toAppend.push(desc.value);
  }

  function isObjectLike(v) {
    return (typeof v === "object" && v !== null) || typeof v === "function";
  }

  function printErrorProperty(f, key, value, longest) {
    const saved = {
      disable: f.disableInspectCustom,
      quote: f.quoteStrings,
      maxDepth: f.maxDepth,
      outer: f.outerMaxDepth,
      asText: f.formatBufferAsText,
    };
    f.depth += 1;
    f.formatBufferAsText = true;
    f.outerMaxDepth = f.errorChainMaxDepth();
    f.maxDepth = f.depth;
    f.quoteStrings = true;
    f.disableInspectCustom = true;
    try {
      const text = keyText(key);
      f.write(spaces(longest - text.length) + " " + text + ": ");
      f.format(tagOf(value, { hideGlobal: true, disableCustom: true }), value);
      f.write(",\n");
    } finally {
      f.depth -= 1;
      f.maxDepth = saved.maxDepth;
      f.outerMaxDepth = saved.outer;
      f.quoteStrings = saved.quote;
      f.disableInspectCustom = saved.disable;
      f.formatBufferAsText = saved.asText;
    }
  }

  // The cause / errors chain, guarded against cycles via the visited set.
  function printAppendedErrors(f, toAppend) {
    for (const err of toAppend) {
      if (f.visited.has(err)) {
        f.write("\n[Circular]");
        continue;
      }
      f.visited.add(err);
      f.write("\n");
      const prevDepth = f.depth;
      f.depth += 1;
      try {
        if (f.depth > f.errorChainMaxDepth()) {
          f.write("[Error ...]");
        } else {
          printErrorInstance(f, err);
        }
      } finally {
        f.depth = prevDepth;
        f.visited.delete(err);
      }
    }
  }

  Formatter.prototype.printError = function (value) {
    // print_as already put `value` into the visited set; Bun removes it while
    // printing so its own cause chain doesn't see it as circular.
    const wasVisited = this.visited.delete(value);
    try {
      printErrorLike(this, value);
    } finally {
      if (wasVisited) this.visited.add(value);
    }
  };

  // Non-Error thrown values (`throw "str"`, `throw {a: 1}`, ...).
  function formatThrownValue(f, value) {
    f.write(errorNameAndMessage("", thrownMessage(value), undefined));
    f.format(tagOf(value, { hideGlobal: true, disableCustom: true }), value);
    f.write("\n");
  }

  function thrownMessage(value) {
    if (typeof value === "symbol") return value.description || "";
    if (isObjectLike(value)) return "";
    return String(value);
  }

  // ───────────────────────────── public API ─────────────────────────────

  function readInspectOptions(options) {
    const result = { maxDepth: 8, quoteStrings: true, orderedProperties: false, singleLine: false };
    if (options === undefined || options === null) return result;
    if (typeof options !== "object") {
      applyDepth(result, options);
      return result;
    }
    if (options.depth !== undefined) applyDepth(result, options.depth);
    if (options.sorted !== undefined) result.orderedProperties = !!options.sorted;
    if (options.compact !== undefined) result.singleLine = !!options.compact;
    return result;
  }

  function applyDepth(result, depth) {
    if (typeof depth !== "number" || Number.isNaN(depth)) return;
    if (!Number.isFinite(depth)) {
      result.maxDepth = 65535;
      return;
    }
    if (Math.trunc(depth) !== depth) throw new TypeError("expected depth to be an integer, got " + depth);
    if (depth < 0) throw new TypeError("expected depth to be greater than or equal to 0, got " + depth);
    result.maxDepth = Math.min(depth, 65535);
  }

  /** Bun.inspect(value, options?) */
  function bunInspect(value, options) {
    const f = new Formatter(readInspectOptions(options));
    f.format(tagOf(value), value);
    return f.out;
  }

  /** console.log(...args) output without the trailing newline. */
  function formatArgs(args, options) {
    const opts = options || {};
    const f = new Formatter({
      maxDepth: opts.depth === undefined ? 2 : opts.depth,
      quoteStrings: false,
      singleLine: false,
      orderedProperties: false,
    });
    if (args.length === 0) return "";
    f.remaining = Array.prototype.slice.call(args, 1);
    let current = args[0];
    for (let first = true; ; first = false) {
      if (!first) f.write(" ");
      const tag = tagOf(current);
      if (tag.tag === "String" && !tag.boxed && f.remaining.length > 0) tag.tag = "StringPossiblyFormatted";
      f.format(tag, current);
      if (f.remaining.length === 0) break;
      current = f.remaining.shift();
    }
    return f.out;
  }

  /** Bun's error printing (console.log(err) and uncaught exceptions). */
  function formatError(err, options) {
    const opts = options || {};
    const f = new Formatter({ maxDepth: opts.depth === undefined ? 2 : opts.depth, quoteStrings: false });
    if (isObjectLike(err) && isErrorInstance(err)) {
      f.visited.add(err);
      printErrorLike(f, err);
      return f.out;
    }
    formatThrownValue(f, err);
    return f.out;
  }

  // ───────────────────────────── Node util.inspect ─────────────────────────────

  // @@NODE_INSPECT_BEGIN@@
function createNodeInspect(internal) {
  // Plain-JavaScript port of Node's util.inspect / util.format, adapted from
  // Bun's copy of lib/internal/util/inspect.js (MIT, Node.js contributors).
  // Primordials are replaced with ordinary method calls, and V8/JSC internals
  // are emulated with standard brand checks. `internal` supplies the few
  // engine facts JavaScript cannot observe: promise state/result, whether a
  // value is a Proxy, and whether it is a module namespace object.

  // ---------------------------------------------------------------------------
  // Captured intrinsics and brand checks
  // ---------------------------------------------------------------------------

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const isEnumerable = (obj, key) => Object.prototype.propertyIsEnumerable.call(obj, key);
  const objectToString = value => Object.prototype.toString.call(value);
  const errorToString = value => Error.prototype.toString.call(value);
  const functionToString = value => Function.prototype.toString.call(value);

  function getterOf(proto, key) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    return descriptor === undefined ? undefined : descriptor.get;
  }

  // True when `fn.call(value, ...args)` does not throw. Used for brand checks
  // with side-effect-free intrinsics (getters, valueOf, has).
  function passesBrand(fn, value, arg) {
    if (typeof fn !== "function") return false;
    try {
      fn.call(value, arg);
      return true;
    } catch {
      return false;
    }
  }

  const mapSize = getterOf(Map.prototype, "size");
  const setSize = getterOf(Set.prototype, "size");
  const mapEntries = Map.prototype.entries;
  const setValues = Set.prototype.values;
  const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayTag = getterOf(TypedArrayPrototype, Symbol.toStringTag);
  const typedArrayLength = getterOf(TypedArrayPrototype, "length");
  const arrayBufferByteLength = getterOf(ArrayBuffer.prototype, "byteLength");
  const sharedArrayBufferByteLength =
    typeof SharedArrayBuffer === "function" ? getterOf(SharedArrayBuffer.prototype, "byteLength") : undefined;
  const dataViewBuffer = getterOf(DataView.prototype, "buffer");
  const regExpSource = getterOf(RegExp.prototype, "source");
  const MapIteratorPrototype = Object.getPrototypeOf(new Map().entries());
  const SetIteratorPrototype = Object.getPrototypeOf(new Set().values());
  const mapIteratorNext = MapIteratorPrototype.next;
  const setIteratorNext = SetIteratorPrototype.next;
  /* eslint-disable no-empty-function */
  const AsyncFunctionPrototype = Object.getPrototypeOf(async function () {});
  const GeneratorFunctionPrototype = Object.getPrototypeOf(function* () {});
  const AsyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function* () {});
  /* eslint-enable no-empty-function */

  // Typed array constructors by tag, used to rebuild null-prototype views.
  const typedArrayConstructors = {};
  for (const name of [
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
    "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  ]) {
    if (typeof globalThis[name] === "function") typedArrayConstructors[name] = globalThis[name];
  }

  const isMap = value => passesBrand(mapSize, value);
  const isSet = value => passesBrand(setSize, value);
  // The %TypedArray% toStringTag getter returns undefined for non-views.
  const isTypedArray = value => typedArrayTag.call(value) !== undefined;
  const isArrayBuffer = value => passesBrand(arrayBufferByteLength, value);
  const isSharedArrayBuffer = value => passesBrand(sharedArrayBufferByteLength, value);
  const isAnyArrayBuffer = value => isArrayBuffer(value) || isSharedArrayBuffer(value);
  const isDataView = value => passesBrand(dataViewBuffer, value);
  const isDate = value => passesBrand(Date.prototype.getTime, value);
  // RegExp.prototype itself answers the `source` getter without being a RegExp.
  const isRegExp = value => value !== RegExp.prototype && passesBrand(regExpSource, value);
  const isWeakMap = value => passesBrand(WeakMap.prototype.has, value, {});
  const isWeakSet = value => passesBrand(WeakSet.prototype.has, value, {});
  const isNumberObject = value => passesBrand(Number.prototype.valueOf, value);
  const isStringObject = value => passesBrand(String.prototype.valueOf, value);
  const isBooleanObject = value => passesBrand(Boolean.prototype.valueOf, value);
  const isBigIntObject = value => typeof BigInt === "function" && passesBrand(BigInt.prototype.valueOf, value);
  const isSymbolObject = value => passesBrand(Symbol.prototype.valueOf, value);
  const isBoxedPrimitive = value =>
    isNumberObject(value) || isStringObject(value) || isBooleanObject(value) ||
    isBigIntObject(value) || isSymbolObject(value);
  const isMapIterator = value => Object.getPrototypeOf(value) === MapIteratorPrototype;
  const isSetIterator = value => Object.getPrototypeOf(value) === SetIteratorPrototype;
  const isModuleNamespaceObject = value => internal.isESMNamespace(value) === true;
  const isProxy = value => internal.isProxy(value) === true;

  // Object.prototype.toString honours Symbol.toStringTag, so these checks only
  // trust the builtin tag when no string tag is reachable.
  const hasBuiltinTag = (value, tag) =>
    typeof value[Symbol.toStringTag] !== "string" && objectToString(value) === `[object ${tag}]`;
  const isArgumentsObject = value => hasBuiltinTag(value, "Arguments");
  const isNativeError =
    typeof Error.isError === "function" ? value => Error.isError(value) : value => hasBuiltinTag(value, "Error");
  const isPromise = value =>
    value !== Promise.prototype &&
    !hasOwn(value, Symbol.toStringTag) &&
    objectToString(value) === "[object Promise]";

  const protoChainIncludes = (value, proto) => {
    for (let obj = Object.getPrototypeOf(value); obj !== null; obj = Object.getPrototypeOf(obj)) {
      if (obj === proto) return true;
    }
    return false;
  };
  const isAsyncFunction = value =>
    protoChainIncludes(value, AsyncFunctionPrototype) || protoChainIncludes(value, AsyncGeneratorFunctionPrototype);
  const isGeneratorFunction = value =>
    protoChainIncludes(value, GeneratorFunctionPrototype) || protoChainIncludes(value, AsyncGeneratorFunctionPrototype);

  // Node's Buffer is a Uint8Array subclass with its own inspect output.
  const isBuffer = value =>
    isTypedArray(value) &&
    typedArrayTag.call(value) === "Uint8Array" &&
    ((value.constructor && value.constructor.name === "Buffer") || typeof value.readUInt8 === "function");

  // A revoked proxy makes Array.isArray throw without running any trap.
  function isRevokedProxy(value) {
    try {
      Array.isArray(value);
      return false;
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  const kPending = 0;
  const kFulfilled = 1;
  const kRejected = 2;
  const kObjectType = 0;
  const kArrayType = 1;
  const kArrayExtrasType = 2;
  const kWeak = 0;
  const kIterator = 1;
  const kMapEntries = 2;
  const kMinLineLength = 16;
  const INSPECT_MAX_BYTES = 50;
  const STACK_OVERFLOW_MESSAGE = "Maximum call stack size exceeded.";

  // Names Node treats as built-in constructors (prototype properties of these
  // are never listed with showHidden).
  const builtInObjects = new Set([
    "AggregateError", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array",
    "BigUint64Array", "Boolean", "DataView", "Date", "Error", "EvalError",
    "FinalizationRegistry", "Float32Array", "Float64Array", "Function", "Infinity",
    "Int16Array", "Int32Array", "Int8Array", "Intl", "Iterator", "JSON", "Map",
    "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError",
    "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError",
    "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
    "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet",
  ]);

  const inspectDefaultOptions = Object.seal({
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
  });

  const strEscapeSequencesRegExp =
    /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const strEscapeSequencesReplacer =
    /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  const strEscapeSequencesRegExpSingle =
    /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const strEscapeSequencesReplacerSingle =
    /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  const newLineSplitRegExp = /(?<=\n)/;
  const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
  const numberRegExp = /^(0|[1-9][0-9]*)$/;
  const classRegExp = /^(\s+[^(]*?)\s*{/;
  const stripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;
  // A QuickJS stack has frames only: "    at f (file:1:2)\n...".
  const headerlessStackRegExp = /^\s*at /;

  // Escapes for control characters, the single quote and the backslash.
  const meta = Array.from({ length: 0xa0 }, (_, code) => {
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return "";
  });
  meta[8] = "\\b";
  meta[9] = "\\t";
  meta[10] = "\\n";
  meta[12] = "\\f";
  meta[13] = "\\r";
  meta[39] = "\\'";
  meta[92] = "\\\\";

  // ---------------------------------------------------------------------------
  // Public inspect()
  // ---------------------------------------------------------------------------

  function inspect(value, opts) {
    const ctx = {
      budget: {},
      indentationLvl: 0,
      seen: [],
      currentDepth: 0,
      stylize: stylizeNoColor,
      showHidden: inspectDefaultOptions.showHidden,
      depth: inspectDefaultOptions.depth,
      colors: inspectDefaultOptions.colors,
      customInspect: inspectDefaultOptions.customInspect,
      showProxy: inspectDefaultOptions.showProxy,
      maxArrayLength: inspectDefaultOptions.maxArrayLength,
      maxStringLength: inspectDefaultOptions.maxStringLength,
      breakLength: inspectDefaultOptions.breakLength,
      compact: inspectDefaultOptions.compact,
      sorted: inspectDefaultOptions.sorted,
      getters: inspectDefaultOptions.getters,
      numericSeparator: inspectDefaultOptions.numericSeparator,
    };
    const argc = arguments.length;
    if (argc > 1) {
      // Legacy signature: inspect(value, showHidden, depth, colors).
      if (argc > 2 && arguments[2] !== undefined) ctx.depth = arguments[2];
      if (argc > 3 && arguments[3] !== undefined) ctx.colors = arguments[3];
      if (typeof opts === "boolean") {
        ctx.showHidden = opts;
      } else if (opts) {
        applyUserOptions(ctx, opts);
      }
    }
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
  }

  function applyUserOptions(ctx, opts) {
    for (const key of Object.keys(opts)) {
      if (hasOwn(inspectDefaultOptions, key) || key === "stylize") {
        ctx[key] = opts[key];
      } else if (ctx.userOptions === undefined) {
        // Pass unknown user options through to custom inspect functions.
        ctx.userOptions = opts;
      }
    }
  }

  function validateObject(value, name) {
    if (value === null || typeof value !== "object") {
      const error = new TypeError(`The "${name}" argument must be of type object. Received ${describeReceived(value)}`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
  }

  function describeReceived(value) {
    if (value == null) return String(value);
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") return `an instance of ${internalGetConstructorName(value)}`;
    let shown = inspect(value, { colors: false });
    if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
    return `type ${typeof value} (${shown})`;
  }

  inspect.custom = customInspectSymbol;
  Object.defineProperty(inspect, "defaultOptions", {
    get() {
      return inspectDefaultOptions;
    },
    set(options) {
      validateObject(options, "options");
      return Object.assign(inspectDefaultOptions, options);
    },
  });

  // Set Graphics Rendition codes: [enable, reset].
  const defaultFG = 39;
  const defaultBG = 49;
  inspect.colors = {
    __proto__: null,
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
    black: [30, defaultFG],
    red: [31, defaultFG],
    green: [32, defaultFG],
    yellow: [33, defaultFG],
    blue: [34, defaultFG],
    magenta: [35, defaultFG],
    cyan: [36, defaultFG],
    white: [37, defaultFG],
    bgBlack: [40, defaultBG],
    bgRed: [41, defaultBG],
    bgGreen: [42, defaultBG],
    bgYellow: [43, defaultBG],
    bgBlue: [44, defaultBG],
    bgMagenta: [45, defaultBG],
    bgCyan: [46, defaultBG],
    bgWhite: [47, defaultBG],
    framed: [51, 54],
    overlined: [53, 55],
    gray: [90, defaultFG],
    redBright: [91, defaultFG],
    greenBright: [92, defaultFG],
    yellowBright: [93, defaultFG],
    blueBright: [94, defaultFG],
    magentaBright: [95, defaultFG],
    cyanBright: [96, defaultFG],
    whiteBright: [97, defaultFG],
    bgGray: [100, defaultBG],
    bgRedBright: [101, defaultBG],
    bgGreenBright: [102, defaultBG],
    bgYellowBright: [103, defaultBG],
    bgBlueBright: [104, defaultBG],
    bgMagentaBright: [105, defaultBG],
    bgCyanBright: [106, defaultBG],
    bgWhiteBright: [107, defaultBG],
  };

  function defineColorAlias(target, alias) {
    Object.defineProperty(inspect.colors, alias, {
      get() {
        return this[target];
      },
      set(value) {
        this[target] = value;
      },
      configurable: true,
      enumerable: false,
    });
  }

  defineColorAlias("gray", "grey");
  defineColorAlias("gray", "blackBright");
  defineColorAlias("bgGray", "bgGrey");
  defineColorAlias("bgGray", "bgBlackBright");
  defineColorAlias("dim", "faint");
  defineColorAlias("strikethrough", "crossedout");
  defineColorAlias("strikethrough", "strikeThrough");
  defineColorAlias("strikethrough", "crossedOut");
  defineColorAlias("hidden", "conceal");
  defineColorAlias("inverse", "swapColors");
  defineColorAlias("inverse", "swapcolors");
  defineColorAlias("doubleunderline", "doubleUnderline");

  inspect.styles = {
    __proto__: null,
    special: "cyan",
    number: "yellow",
    bigint: "yellow",
    boolean: "yellow",
    undefined: "grey",
    null: "bold",
    string: "green",
    symbol: "green",
    date: "magenta",
    // "name": intentionally not styling
    regexp: highlightRegExp,
    module: "underline",
  };
  // Palette for RegExp group depth highlighting. Users may change it.
  highlightRegExp.colors = ["green", "red", "yellow", "cyan", "magenta"];
  const highlightRegExpColors = highlightRegExp.colors.slice();

  // ---------------------------------------------------------------------------
  // Strings and styling
  // ---------------------------------------------------------------------------

  function addQuotes(str, quotes) {
    if (quotes === -1) return `"${str}"`;
    if (quotes === -2) return `\`${str}\``;
    return `'${str}'`;
  }

  function escapeFn(str) {
    const charCode = str.charCodeAt(0);
    return meta.length > charCode ? meta[charCode] : `\\u${charCode.toString(16)}`;
  }

  // Escape control characters, single quotes and the backslash, and pick the
  // quote character that needs the least escaping.
  function strEscape(str) {
    let escapeTest = strEscapeSequencesRegExp;
    let escapeReplace = strEscapeSequencesReplacer;
    let singleQuote = 39;

    if (str.includes("'")) {
      if (!str.includes('"')) {
        singleQuote = -1;
      } else if (!str.includes("`") && !str.includes("${")) {
        singleQuote = -2;
      }
      if (singleQuote !== 39) {
        escapeTest = strEscapeSequencesRegExpSingle;
        escapeReplace = strEscapeSequencesReplacerSingle;
      }
    }

    if (str.length < 5000 && escapeTest.exec(str) === null) return addQuotes(str, singleQuote);
    if (str.length > 100) return addQuotes(str.replace(escapeReplace, escapeFn), singleQuote);

    let result = "";
    let last = 0;
    for (let i = 0; i < str.length; i++) {
      const point = str.charCodeAt(i);
      if (point === singleQuote || point === 92 || point < 32 || (point > 126 && point < 160)) {
        result += str.slice(last, i) + meta[point];
        last = i + 1;
        continue;
      }
      if (point < 0xd800 || point > 0xdfff) continue;
      if (point <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          continue;
        }
      }
      // Lone surrogate.
      result += `${str.slice(last, i)}\\u${point.toString(16)}`;
      last = i + 1;
    }
    if (last !== str.length) result += str.slice(last);
    return addQuotes(result, singleQuote);
  }

  // Colour a RegExp source by group depth (Node 24+ behaviour).
  function highlightRegExp(regexpString) {
    const length = regexpString.length;
    let out = "";
    let i = 0;
    let depth = 0;
    let inClass = false;

    const paletteNames =
      highlightRegExp.colors && highlightRegExp.colors.length > 0 ? highlightRegExp.colors : highlightRegExpColors;
    const palette = [];
    for (const name of paletteNames) {
      const color = inspect.colors[name];
      if (color) palette.push([`\u001b[${color[0]}m`, `\u001b[${color[1]}m`]);
    }

    function write(str) {
      const color = palette[depth % palette.length] ?? palette[0];
      out += color[0] + str + color[1];
    }

    function writeDepth(str, incDepth, incI) {
      depth += incDepth;
      write(str);
      depth -= incDepth;
      i += incI;
    }

    function writeGroup(start, end, decreaseDepth = 1) {
      let seq = "";
      i++;
      while (i < length && regexpString[i] !== end) seq += regexpString[i++];
      if (i < length) {
        depth -= decreaseDepth;
        write(start);
        writeDepth(seq, 1, 1);
        write(end);
        depth += decreaseDepth;
      } else {
        // Unclosed group: avoid corrupting the output.
        writeDepth(start, 1, -seq.length);
      }
    }

    function writeClassChar(ch) {
      if (ch === "\\") {
        let seq = "\\";
        i++;
        if (i < length) {
          seq += regexpString[i++];
          const next = seq[1];
          if ((next === "u" || next === "p" || next === "P") && regexpString[i] === "{") {
            writeGroup(`${seq}{`, "}", 0);
            return;
          }
          if (next === "x") {
            seq += regexpString.slice(i, i + 2);
            i += 2;
          }
        }
        write(seq);
      } else if (ch === "]") {
        depth--;
        write("]");
        i++;
        inClass = false;
      } else if (ch === "-" && regexpString[i - 1] !== "[" && i + 1 < length && regexpString[i + 1] !== "]") {
        writeDepth("-", 1, 1);
      } else {
        write(ch);
        i++;
      }
    }

    function writeGroupOpen() {
      write("(");
      depth++;
      i++;
      if (i >= length || regexpString[i] !== "?") return;
      i++;
      const a = i < length ? regexpString[i] : "";
      if (a === ":" || a === "=" || a === "!") {
        writeDepth(`?${a}`, -1, 1);
        return;
      }
      const b = i + 1 < length ? regexpString[i + 1] : "";
      if (a === "<" && (b === "=" || b === "!")) {
        writeDepth(`?<${b}`, -1, 2);
        return;
      }
      if (a !== "<") {
        write("?");
        return;
      }
      // Named capture: write '?<name>' as a single coloured token.
      i++;
      const start = i;
      while (i < length && regexpString[i] !== ">") i++;
      const name = regexpString.slice(start, i);
      if (i < length) {
        depth--;
        write("?<");
        writeDepth(name, 1, 0);
        write(">");
        depth++;
        i++;
      } else {
        writeDepth("?<", -1, 0);
        write(name);
      }
    }

    function writeEscape() {
      let seq = "\\";
      i++;
      if (i < length) {
        seq += regexpString[i++];
        const next = seq[1];
        if (i < length) {
          if ((next === "u" || next === "p" || next === "P") && regexpString[i] === "{") {
            writeGroup(`${seq}{`, "}", 0);
            return;
          }
          if (next === "k" && regexpString[i] === "<") {
            writeGroup(`${seq}<`, ">");
            return;
          }
          if (next === "x") {
            seq += regexpString.slice(i, i + 2);
            i += 2;
          } else if (next >= "0" && next <= "9") {
            while (i < length && regexpString[i] >= "0" && regexpString[i] <= "9") seq += regexpString[i++];
          }
        }
      }
      writeDepth(seq, 1, 0);
    }

    function readDigits() {
      let digits = "";
      while (i < length && regexpString[i] >= "0" && regexpString[i] <= "9") digits += regexpString[i++];
      return digits;
    }

    function writeQuantifier() {
      i++;
      const digits = readDigits();
      if (digits) {
        write("{");
        depth++;
        writeDepth(digits, 1, 0);
      }
      if (i < length) {
        if (regexpString[i] === ",") {
          if (!digits) {
            write("{");
            depth++;
          }
          write(",");
          i++;
        } else if (!digits) {
          depth += 1;
          write("{");
          depth -= 1;
          return;
        }
      }
      const digits2 = readDigits();
      if (digits2) writeDepth(digits2, 1, 0);
      if (i < length && regexpString[i] === "}") {
        depth--;
        write("}");
        i++;
      }
      if (i < length && regexpString[i] === "?") writeDepth("?", 3, 1);
    }

    write("/");
    depth++;
    i = 1;
    while (i < length) {
      const ch = regexpString[i];
      if (inClass) {
        writeClassChar(ch);
      } else if (ch === "[") {
        write("[");
        depth++;
        i++;
        inClass = true;
      } else if (ch === "(") {
        writeGroupOpen();
      } else if (ch === ")") {
        depth--;
        write(")");
        i++;
      } else if (ch === "\\") {
        writeEscape();
      } else if ("|+*?,^$".includes(ch)) {
        writeDepth(ch, 3, 1);
      } else if (ch === "{") {
        writeQuantifier();
      } else if (ch === ".") {
        writeDepth(ch, 2, 1);
      } else if (ch === "/") {
        break;
      } else {
        writeDepth(ch, 1, 1);
      }
    }
    writeDepth("/", -1, 1);
    if (i < length) write(regexpString.slice(i));
    return out;
  }

  function stylizeWithColor(str, styleType) {
    const style = inspect.styles[styleType];
    if (style === undefined) return str;
    if (typeof style === "function") return style(str);
    const color = inspect.colors[style];
    if (color === undefined) return str;
    return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
  }

  function stylizeNoColor(str) {
    return str;
  }

  // Node's ansi matcher: only complete escape sequences are stripped.
  const ansiRegExp = new RegExp(
    "[\\u001B\\u009B][[\\]()#;?]*" +
      "(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*" +
      "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?" +
      "(?:\\u0007|\\u001B\\u005C|\\u009C))" +
      "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?" +
      "[\\dA-PR-TZcf-nq-uy=><~]))",
    "g",
  );

  function stripVTControlCharacters(str) {
    if (!str.includes("\u001B") && !str.includes("\u009B")) return str;
    return str.replace(ansiRegExp, "");
  }

  // Node's non-ICU getStringWidth: per code point, wide = 2, zero-width = 0.
  function isFullWidthCodePoint(code) {
    return (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
        (code >= 0x3250 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0xa4c6) ||
        (code >= 0xa960 && code <= 0xa97c) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6b) ||
        (code >= 0xff01 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1b000 && code <= 0x1b001) ||
        (code >= 0x1f200 && code <= 0x1f251) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x3fffd))
    );
  }

  function isZeroWidthCodePoint(code) {
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x300 && code <= 0x36f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xfe20 && code <= 0xfe2f) ||
      (code >= 0xe0100 && code <= 0xe01ef)
    );
  }

  function getStringWidth(str, removeControlChars = true) {
    if (removeControlChars) str = stripVTControlCharacters(str);
    // Fast path: printable ASCII is one column per character.
    if (/^[\x20-\x7e]*$/.test(str)) return str.length;
    str = str.normalize("NFC");
    let width = 0;
    for (const char of str) {
      const code = char.codePointAt(0);
      if (isFullWidthCodePoint(code)) width += 2;
      else if (!isZeroWidthCodePoint(code)) width++;
    }
    return width;
  }

  // ---------------------------------------------------------------------------
  // Constructor names, prefixes and keys
  // ---------------------------------------------------------------------------

  function isInstanceof(object, proto) {
    try {
      return object instanceof proto;
    } catch {
      return false;
    }
  }

  // Builtin prototypes, in case their `constructor` property was tampered with.
  const wellKnownPrototypes = new Map([
    [Array.prototype, { name: "Array", constructor: Array }],
    [ArrayBuffer.prototype, { name: "ArrayBuffer", constructor: ArrayBuffer }],
    [Function.prototype, { name: "Function", constructor: Function }],
    [Map.prototype, { name: "Map", constructor: Map }],
    [Object.prototype, { name: "Object", constructor: Object }],
    [Set.prototype, { name: "Set", constructor: Set }],
  ]);

  function getConstructorName(obj, ctx, recurseTimes, protoProps) {
    let firstProto;
    const tmp = obj;
    while (obj) {
      const wellKnown = wellKnownPrototypes.get(obj);
      if (wellKnown !== undefined && tmp instanceof wellKnown.constructor) {
        if (protoProps !== undefined && firstProto !== obj) {
          addPrototypeProperties(ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
        }
        return wellKnown.name;
      }
      const descriptor = Object.getOwnPropertyDescriptor(obj, "constructor");
      const ctor = descriptor !== undefined ? descriptor.value : undefined;
      if (typeof ctor === "function" && ctor.name !== "" && isInstanceof(tmp, ctor)) {
        if (protoProps !== undefined && (firstProto !== obj || !builtInObjects.has(ctor.name))) {
          addPrototypeProperties(ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
        }
        return String(ctor.name);
      }
      obj = Object.getPrototypeOf(obj);
      if (firstProto === undefined) firstProto = obj;
    }

    if (firstProto === null) return null;

    const res = internalGetConstructorName(tmp);
    if (recurseTimes > ctx.depth && ctx.depth !== null) return `${res} <Complex prototype>`;

    const protoConstr = getConstructorName(firstProto, ctx, recurseTimes + 1, protoProps);
    if (protoConstr === null) {
      const shown = inspect(firstProto, Object.assign({}, ctx, { customInspect: false, depth: -1 }));
      return `${res} <${shown}>`;
    }
    return `${res} <${protoConstr}>`;
  }

  // With showHidden, list user-defined (non-function) prototype properties,
  // up to three prototype layers deep.
  function addPrototypeProperties(ctx, main, obj, recurseTimes, output) {
    let depth = 0;
    let keys;
    let keySet;
    do {
      if (depth !== 0 || main === obj) {
        obj = Object.getPrototypeOf(obj);
        if (obj === null) return;
        const descriptor = Object.getOwnPropertyDescriptor(obj, "constructor");
        if (descriptor !== undefined && typeof descriptor.value === "function" && builtInObjects.has(descriptor.value.name)) {
          return;
        }
      }
      if (depth === 0) {
        keySet = new Set();
      } else {
        for (const key of keys) keySet.add(key);
      }
      keys = Reflect.ownKeys(obj);
      ctx.seen.push(main);
      for (const key of keys) {
        if (key === "constructor" || hasOwn(main, key) || (depth !== 0 && keySet.has(key))) continue;
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (typeof desc.value === "function") continue;
        const value = formatProperty(ctx, obj, recurseTimes, key, kObjectType, desc, main);
        output.push(ctx.colors ? `\u001b[2m${value}\u001b[22m` : value);
      }
      ctx.seen.pop();
    } while (++depth !== 3);
  }

  function getPrefix(constructor, tag, fallback, size = "") {
    if (constructor === null) {
      if (tag !== "" && fallback !== tag) return `[${fallback}${size}: null prototype] [${tag}] `;
      return `[${fallback}${size}: null prototype] `;
    }
    if (tag !== "" && constructor !== tag) return `${constructor}${size} [${tag}] `;
    return `${constructor}${size} `;
  }

  function getKeys(value, showHidden) {
    const symbols = Object.getOwnPropertySymbols(value);
    if (showHidden) return Object.getOwnPropertyNames(value).concat(symbols);
    let keys;
    try {
      keys = Object.keys(value);
    } catch (err) {
      // Namespace objects of unevaluated modules throw on [[Get]].
      if (!isModuleNamespaceObject(value)) throw err;
      keys = Object.getOwnPropertyNames(value);
    }
    if (symbols.length === 0) return keys;
    return keys.concat(symbols.filter(key => isEnumerable(value, key)));
  }

  const isArrayIndexKey = key => numberRegExp.test(key) && Number(key) < 2 ** 32 - 1;

  // Emulates V8's GetOwnNonIndexProperties for arrays and typed arrays.
  function getOwnNonIndexProperties(value, showHidden) {
    const names = Object.getOwnPropertyNames(value).filter(
      key => !isArrayIndexKey(key) && (showHidden || isEnumerable(value, key)),
    );
    const symbols = Object.getOwnPropertySymbols(value).filter(key => showHidden || isEnumerable(value, key));
    return names.concat(symbols);
  }

  function internalGetConstructorName(value) {
    const ctor = value.constructor;
    const name = ctor ? ctor.name : undefined;
    if (name) return name;
    const match = objectToString(value).match(/^\[object ([^\]]+)\]/);
    return match ? match[1] : "Object";
  }

  function getCtxStyle(value, constructor, tag) {
    let fallback = "";
    if (constructor === null) {
      fallback = internalGetConstructorName(value);
      if (fallback === tag) fallback = "Object";
    }
    return getPrefix(constructor, tag, fallback);
  }

  // ---------------------------------------------------------------------------
  // formatValue / formatRaw
  // ---------------------------------------------------------------------------

  function getUserOptions(ctx, isCrossContext) {
    const ret = Object.assign(
      {
        stylize: ctx.stylize,
        showHidden: ctx.showHidden,
        depth: ctx.depth,
        colors: ctx.colors,
        customInspect: ctx.customInspect,
        showProxy: ctx.showProxy,
        maxArrayLength: ctx.maxArrayLength,
        maxStringLength: ctx.maxStringLength,
        breakLength: ctx.breakLength,
        compact: ctx.compact,
        sorted: ctx.sorted,
        getters: ctx.getters,
        numericSeparator: ctx.numericSeparator,
      },
      ctx.userOptions,
    );
    if (!isCrossContext) return ret;

    // Don't hand our own objects to values that may come from elsewhere: keep
    // primitives only, plus a stylize that always returns a string.
    Object.setPrototypeOf(ret, null);
    for (const key of Object.keys(ret)) {
      if ((typeof ret[key] === "object" || typeof ret[key] === "function") && ret[key] !== null) delete ret[key];
    }
    ret.stylize = Object.setPrototypeOf((value, flavour) => {
      let stylized;
      try {
        stylized = `${ctx.stylize(value, flavour)}`;
      } catch {
        // Continue regardless of error.
      }
      return typeof stylized === "string" ? stylized : value;
    }, null);
    return ret;
  }

  function formatValue(ctx, value, recurseTimes, typedArray) {
    if (typeof value !== "object" && typeof value !== "function") return formatPrimitive(ctx.stylize, value, ctx);
    if (value === null) return ctx.stylize("null", "null");

    // The proxy target is not reachable from JavaScript, so a live proxy is
    // inspected through its traps (Node would read the target directly).
    const proxied = isProxy(value);
    if (proxied && isRevokedProxy(value)) return ctx.stylize("<Revoked Proxy>", "special");

    if (ctx.customInspect) {
      const custom = formatCustom(ctx, value, recurseTimes, proxied);
      if (custom !== undefined) return custom;
    }

    if (ctx.seen.includes(value)) return formatCircular(ctx, value);
    return formatRaw(ctx, value, recurseTimes, typedArray);
  }

  // Runs a user `[util.inspect.custom]` method (or the Buffer formatter).
  // Returns undefined when the value has no custom representation.
  function formatCustom(ctx, value, recurseTimes, proxied) {
    const maybeCustom = value[customInspectSymbol];
    if (typeof maybeCustom !== "function") {
      return isBuffer(value) ? formatBuffer(ctx, value) : undefined;
    }
    // Skip util.inspect itself and prototype objects (circular constructor check).
    if (maybeCustom === inspect) return undefined;
    const ctorDescriptor = Object.getOwnPropertyDescriptor(value, "constructor");
    if (ctorDescriptor && ctorDescriptor.value && ctorDescriptor.value.prototype === value) return undefined;

    const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
    const isCrossContext = proxied || !(value instanceof Object);
    const ret = maybeCustom.call(value, depth, getUserOptions(ctx, isCrossContext), inspect);
    // A custom inspector returning `this` falls back to the default output.
    if (ret === value) return undefined;
    if (typeof ret !== "string") return formatValue(ctx, ret, recurseTimes);
    return ret.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
  }

  function formatCircular(ctx, value) {
    let index = 1;
    if (ctx.circular === undefined) {
      ctx.circular = new Map([[value, index]]);
    } else {
      index = ctx.circular.get(value);
      if (index === undefined) {
        index = ctx.circular.size + 1;
        ctx.circular.set(value, index);
      }
    }
    return ctx.stylize(`[Circular *${index}]`, "special");
  }

  // Node's Buffer.prototype[util.inspect.custom]: `<Buffer 01 02, extra: 1>`.
  function formatBuffer(ctx, buffer) {
    const length = typedArrayLength.call(buffer);
    const actualMax = Math.min(INSPECT_MAX_BYTES, length);
    const remaining = length - INSPECT_MAX_BYTES;
    let str = hexBytes(buffer, actualMax).replace(/(.{2})/g, "$1 ").trim();
    if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;

    const extraKeys = getOwnNonIndexProperties(buffer, ctx.showHidden);
    if (extraKeys.length !== 0) {
      const obj = { __proto__: null };
      for (const key of extraKeys) obj[key] = buffer[key];
      if (length !== 0) str += ", ";
      const options = Object.assign(getUserOptions(ctx, false), { breakLength: Infinity, compact: true });
      // '[Object: null prototype] {'.length === 26
      str += inspect(obj, options).slice(27, -2);
    }
    const name = buffer.constructor && buffer.constructor.name ? buffer.constructor.name : "Buffer";
    return `<${name} ${str}>`;
  }

  function hexBytes(bytes, count) {
    let out = "";
    for (let i = 0; i < count; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  // Describes how formatRaw prints a value: the braces, the entry formatter
  // and which keys to list. `base` is text printed before the braces.
  function describeIterable(ctx, value, constructor, tag, protoProps) {
    const showHidden = ctx.showHidden;
    if (Array.isArray(value)) {
      const prefix =
        constructor !== "Array" || tag !== "" ? getPrefix(constructor, tag, "Array", `(${value.length})`) : "";
      const keys = getOwnNonIndexProperties(value, showHidden);
      const braces = [`${prefix}[`, "]"];
      if (value.length === 0 && keys.length === 0 && protoProps === undefined) return { done: `${braces[0]}]` };
      return { keys, braces, formatter: formatArray, extrasType: kArrayExtrasType };
    }
    if (isSet(value)) {
      const size = setSize.call(value);
      const prefix = getPrefix(constructor, tag, "Set", `(${size})`);
      const keys = getKeys(value, showHidden);
      if (size === 0 && keys.length === 0 && protoProps === undefined) return { done: `${prefix}{}` };
      return { keys, braces: [`${prefix}{`, "}"], formatter: formatSet };
    }
    if (isMap(value)) {
      const size = mapSize.call(value);
      const prefix = getPrefix(constructor, tag, "Map", `(${size})`);
      const keys = getKeys(value, showHidden);
      if (size === 0 && keys.length === 0 && protoProps === undefined) return { done: `${prefix}{}` };
      return { keys, braces: [`${prefix}{`, "}"], formatter: formatMap };
    }
    if (isTypedArray(value)) return describeTypedArray(ctx, value, constructor, tag);
    if (isMapIterator(value) || isSetIterator(value)) {
      const type = isMapIterator(value) ? "Map" : "Set";
      const keys = getKeys(value, showHidden).filter(key => !(key === "next" && iteratorPreviews.has(value)));
      const braces = getIteratorBraces(type, tag);
      return { keys, braces, formatter: (ctx2, v, recurseTimes) => formatIterator(braces, type, ctx2, v, recurseTimes) };
    }
    return undefined;
  }

  function describeTypedArray(ctx, value, constructor, tag) {
    const keys = getOwnNonIndexProperties(value, ctx.showHidden);
    let bound = value;
    let fallback = "";
    if (constructor === null) {
      // Rebuild a normal view so indexing works without a prototype.
      fallback = typedArrayTag.call(value);
      bound = new typedArrayConstructors[fallback](value);
    }
    const size = typedArrayLength.call(value);
    const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
    const braces = [`${prefix}[`, "]"];
    if (size === 0 && keys.length === 0 && !ctx.showHidden) return { done: `${braces[0]}]` };
    const description = {
      keys,
      braces,
      formatter: ctx2 => formatTypedArray(bound, size, ctx2),
      extrasType: kArrayExtrasType,
    };
    if (ctx.showHidden) {
      description.extraKeys = ["BYTES_PER_ELEMENT", "length", "byteLength", "byteOffset", "buffer"];
      description.typedArray = true;
    }
    return description;
  }

  // Values without an iterator (or whose iterator we don't special-case).
  function describePlain(ctx, value, constructor, tag, protoProps, recurseTimes, typedArray) {
    const keys = getKeys(value, ctx.showHidden);
    const braces = ["{", "}"];
    const noProps = keys.length === 0 && protoProps === undefined;
    const plain = { keys, braces, base: "" };

    if (typeof value === "function") {
      plain.base = getFunctionBase(ctx, value, constructor, tag);
      if (noProps) return { done: ctx.stylize(plain.base, "special") };
      return plain;
    }
    if (constructor === "Object") {
      if (isArgumentsObject(value)) {
        braces[0] = "[Arguments] {";
      } else if (tag !== "") {
        braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
      }
      if (noProps) return { done: `${braces[0]}}` };
      return plain;
    }
    if (isRegExp(value)) {
      plain.base = RegExp.prototype.toString.call(constructor !== null ? value : new RegExp(value));
      const prefix = getPrefix(constructor, tag, "RegExp");
      if (prefix !== "RegExp ") plain.base = `${prefix}${plain.base}`;
      if (noProps || (recurseTimes > ctx.depth && ctx.depth !== null)) return { done: ctx.stylize(plain.base, "regexp") };
      return plain;
    }
    if (isDate(value)) {
      const time = Date.prototype.getTime.call(value);
      plain.base = Number.isNaN(time) ? Date.prototype.toString.call(value) : Date.prototype.toISOString.call(value);
      const prefix = getPrefix(constructor, tag, "Date");
      if (prefix !== "Date ") plain.base = `${prefix}${plain.base}`;
      if (noProps) return { done: ctx.stylize(plain.base, "date") };
      return plain;
    }
    if (isNativeError(value) || value instanceof Error) {
      plain.base = formatError(value, constructor, tag, ctx, keys);
      if (keys.length === 0 && protoProps === undefined) return { done: plain.base };
      return plain;
    }
    return describeOther(ctx, value, constructor, tag, protoProps, typedArray, plain);
  }

  function describeOther(ctx, value, constructor, tag, protoProps, typedArray, plain) {
    const { keys, braces } = plain;
    if (isAnyArrayBuffer(value)) {
      const arrayType = isArrayBuffer(value) ? "ArrayBuffer" : "SharedArrayBuffer";
      const prefix = getPrefix(constructor, tag, arrayType);
      if (typedArray === undefined) {
        plain.formatter = formatArrayBuffer;
      } else if (keys.length === 0 && protoProps === undefined) {
        return { done: `${prefix}{ [byteLength]: ${formatNumber(ctx.stylize, value.byteLength, false)} }` };
      }
      braces[0] = `${prefix}{`;
      plain.extraKeys = ["byteLength"];
      return plain;
    }
    if (isDataView(value)) {
      braces[0] = `${getPrefix(constructor, tag, "DataView")}{`;
      // .buffer goes last, it's not a primitive like the others.
      plain.extraKeys = ["byteLength", "byteOffset", "buffer"];
      return plain;
    }
    if (isPromise(value)) {
      braces[0] = `${getPrefix(constructor, tag, "Promise")}{`;
      plain.formatter = formatPromise;
      return plain;
    }
    if (isWeakSet(value) || isWeakMap(value)) {
      // Weak collection contents are not observable from JavaScript.
      braces[0] = `${getPrefix(constructor, tag, isWeakSet(value) ? "WeakSet" : "WeakMap")}{`;
      plain.formatter = formatWeakCollection;
      return plain;
    }
    if (isModuleNamespaceObject(value)) {
      braces[0] = `${getPrefix(constructor, tag, "Module")}{`;
      plain.formatter = (ctx2, v, recurseTimes) => formatNamespaceObject(keys, ctx2, v, recurseTimes);
      return plain;
    }
    if (isBoxedPrimitive(value)) {
      plain.base = getBoxedBase(value, ctx, keys, constructor, tag);
      if (keys.length === 0 && protoProps === undefined) return { done: plain.base };
      return plain;
    }
    if (keys.length === 0 && protoProps === undefined) return { done: `${getCtxStyle(value, constructor, tag)}{}` };
    braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
    return plain;
  }

  function formatRaw(ctx, value, recurseTimes, typedArray) {
    let protoProps;
    if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) protoProps = [];

    const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
    if (protoProps !== undefined && protoProps.length === 0) protoProps = undefined;

    let tag = value[Symbol.toStringTag];
    // Only list the tag when it is not already printed as an own property.
    const tagIsListed = ctx.showHidden ? hasOwn : isEnumerable;
    if (typeof tag !== "string" || (tag !== "" && tagIsListed(value, Symbol.toStringTag))) tag = "";

    let description;
    if (Symbol.iterator in value || constructor === null) {
      description = describeIterable(ctx, value, constructor, tag, protoProps);
    }
    if (description === undefined) {
      description = describePlain(ctx, value, constructor, tag, protoProps, recurseTimes, typedArray);
    }
    if (description.done !== undefined) return description.done;

    const { keys, braces, extraKeys } = description;
    const formatter = description.formatter || (() => []);
    const extrasType = description.extrasType || kObjectType;
    let base = description.base || "";
    if (description.typedArray) typedArray = true;

    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      let constructorName = getCtxStyle(value, constructor, tag).slice(0, -1);
      if (constructor !== null) constructorName = `[${constructorName}]`;
      return ctx.stylize(constructorName, "special");
    }
    recurseTimes += 1;

    ctx.seen.push(value);
    ctx.currentDepth = recurseTimes;
    const indentationLvl = ctx.indentationLvl;
    let output;
    try {
      // Guard deep structures before the engine stack runs out.
      if (ctx.currentDepth > 1000) throw new RangeError(STACK_OVERFLOW_MESSAGE);
      output = formatter(ctx, value, recurseTimes);
      if (extraKeys !== undefined) {
        for (const key of extraKeys) output.push(formatExtraKey(ctx, value, recurseTimes, key, typedArray));
      }
      for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, extrasType));
      if (protoProps !== undefined) output = output.concat(protoProps);
    } catch (err) {
      if (!isStackOverflowError(err)) throw err;
      const constructorName = getCtxStyle(value, constructor, tag).slice(0, -1);
      ctx.seen.pop();
      ctx.indentationLvl = indentationLvl;
      return ctx.stylize(
        `[${constructorName}: Inspection interrupted prematurely. Maximum call stack size exceeded.]`,
        "special",
      );
    }

    const reference = getReference(ctx, value);
    if (reference !== undefined) {
      if (reference.repeated) return reference.text;
      if (ctx.compact !== true) base = base === "" ? reference.text : `${reference.text} ${base}`;
      else braces[0] = `${reference.text} ${braces[0]}`;
    }
    ctx.seen.pop();

    if (ctx.sorted) sortOutput(ctx, output, extrasType, keys.length);

    const res = reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value);
    const newLength = (ctx.budget[ctx.indentationLvl] || 0) + res.length;
    ctx.budget[ctx.indentationLvl] = newLength;
    // Limit huge outputs: once any level exceeds 2 ** 27 characters, inspect
    // the rest at minimal depth.
    if (newLength > 2 ** 27) ctx.depth = -1;
    return res;
  }

  function isStackOverflowError(err) {
    if (err === null || typeof err !== "object") return false;
    const message = String(err.message);
    return message.startsWith("Maximum call stack size exceeded") || message === "stack overflow";
  }

  function formatExtraKey(ctx, value, recurseTimes, key, typedArray) {
    try {
      return formatExtraProperties(ctx, value, recurseTimes, key, typedArray);
    } catch {
      const tempValue = { [key]: value.buffer[key] };
      return formatExtraProperties(ctx, tempValue, recurseTimes, key, typedArray);
    }
  }

  // `<ref *n>` for values that turned out to be circular. Like Bun (and unlike
  // Node), a value already printed with its reference collapses to
  // `[Circular *n]` when it is met again.
  function getReference(ctx, value) {
    if (ctx.circular === undefined) return undefined;
    const index = ctx.circular.get(value);
    if (index === undefined) return undefined;
    if (ctx.seenRefs === undefined) ctx.seenRefs = new Set();
    if (ctx.seenRefs.has(index)) return { repeated: true, text: ctx.stylize(`[Circular *${index}]`, "special") };
    ctx.seenRefs.add(index);
    return { repeated: false, text: ctx.stylize(`<ref *${index}>`, "special") };
  }

  function sortOutput(ctx, output, extrasType, keysLength) {
    const comparator = ctx.sorted === true ? undefined : ctx.sorted;
    if (extrasType === kObjectType) {
      output.sort(comparator);
      return;
    }
    // Only the trailing key entries are sorted; array entries keep their order.
    if (keysLength > 1) {
      const start = output.length - keysLength;
      const sorted = output.slice(start).sort(comparator);
      output.splice(start, keysLength, ...sorted);
    }
  }

  function getIteratorBraces(type, tag) {
    if (tag !== `${type} Iterator`) {
      if (tag !== "") tag += "] [";
      tag += `${type} Iterator`;
    }
    return [`[${tag}] {`, "}"];
  }

  function getBoxedBase(value, ctx, keys, constructor, tag) {
    let fn;
    let type;
    if (isNumberObject(value)) {
      fn = Number.prototype.valueOf;
      type = "Number";
    } else if (isStringObject(value)) {
      fn = String.prototype.valueOf;
      type = "String";
      // Drop the redundant index keys of boxed strings.
      keys.splice(0, value.length);
    } else if (isBooleanObject(value)) {
      fn = Boolean.prototype.valueOf;
      type = "Boolean";
    } else if (isBigIntObject(value)) {
      fn = BigInt.prototype.valueOf;
      type = "BigInt";
    } else {
      fn = Symbol.prototype.valueOf;
      type = "Symbol";
    }
    let base = `[${type}`;
    if (type !== constructor) base += constructor === null ? " (null prototype)" : ` (${constructor})`;
    base += `: ${formatPrimitive(stylizeNoColor, fn.call(value), ctx)}]`;
    if (tag !== "" && tag !== constructor) base += ` [${tag}]`;
    if (keys.length !== 0 || ctx.stylize === stylizeNoColor) return base;
    return ctx.stylize(base, type.toLowerCase());
  }

  function getClassBase(value, constructor, tag) {
    const name = (hasOwn(value, "name") && value.name) || "(anonymous)";
    let base = `class ${name}`;
    if (constructor !== "Function" && constructor !== null) base += ` [${constructor}]`;
    if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
    if (constructor === null) {
      base += " extends [null prototype]";
    } else {
      const superName = Object.getPrototypeOf(value).name;
      if (superName) base += ` extends ${superName}`;
    }
    return `[${base}]`;
  }

  // QuickJS returns the source text, so `class` declarations are recognisable.
  function isClassSource(stringified) {
    if (!stringified.startsWith("class") || stringified[stringified.length - 1] !== "}") return false;
    const slice = stringified.slice(5, -1);
    const bracketIndex = slice.indexOf("{");
    if (bracketIndex === -1) return false;
    return (
      !slice.slice(0, bracketIndex).includes("(") ||
      // Slow path to guarantee that it's indeed a class.
      classRegExp.exec(slice.replace(stripCommentsRegExp, "")) !== null
    );
  }

  function getFunctionBase(ctx, value, constructor, tag) {
    let stringified = "";
    try {
      stringified = functionToString(value);
    } catch {
      // Proxies of functions may refuse toString; treat as a plain function.
    }
    if (isClassSource(stringified)) return getClassBase(value, constructor, tag);

    let type = "Function";
    if (isGeneratorFunction(value)) type = `Generator${type}`;
    if (isAsyncFunction(value)) type = `Async${type}`;
    let base = `[${type}`;
    if (constructor === null) base += " (null prototype)";
    if (value.name === "") {
      base += " (anonymous)";
    } else {
      base += `: ${typeof value.name === "string" ? value.name : formatValue(ctx, value.name)}`;
    }
    base += "]";
    if (constructor !== type && constructor !== null) base += ` ${constructor}`;
    if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
    return base;
  }

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  function identicalSequenceRange(a, b) {
    for (let i = 0; i < a.length - 3; i++) {
      const pos = b.indexOf(a[i]);
      if (pos === -1) continue;
      const rest = b.length - pos;
      if (rest <= 3) continue;
      let len = 1;
      const maxLen = Math.min(a.length - i, rest);
      while (maxLen > len && a[i + len] === b[pos + len]) len++;
      if (len > 3) return { len, offset: i };
    }
    return { len: 0, offset: 0 };
  }

  // The error's stack with a `Name: message` header. QuickJS stacks hold only
  // frames (and end with a newline), so the header V8 would include is added.
  function getStackString(error) {
    const stack = error.stack;
    if (!stack) return errorToString(error);
    const text = String(stack);
    if (!headerlessStackRegExp.test(text)) return text;
    return `${errorToString(error)}\n${text.replace(/\n+$/, "")}`;
  }

  function getStackFrames(ctx, err, stack) {
    const frames = stack.split("\n");
    let cause;
    try {
      cause = err.cause;
    } catch {
      // A throwing `cause` getter is ignored.
    }
    if (cause == null || !(isNativeError(cause) || cause instanceof Error)) return frames;

    // Collapse frames that repeat the cause's stack trace.
    const causeStack = getStackString(cause);
    const causeStackStart = causeStack.indexOf("\n    at");
    if (causeStackStart === -1) return frames;
    const causeFrames = causeStack.slice(causeStackStart + 1).split("\n");
    const { len, offset } = identicalSequenceRange(frames, causeFrames);
    if (len > 0) {
      const skipped = len - 2;
      const msg = `    ... ${skipped} lines matching cause stack trace ...`;
      frames.splice(offset + 1, skipped, ctx.stylize(msg, "undefined"));
    }
    return frames;
  }

  function improveStack(stack, constructor, name, tag) {
    // A stack trace may contain arbitrary data. Only rewrite errors that look
    // normal.
    let len = name.length;
    const looksNormal =
      name.endsWith("Error") && stack.startsWith(name) && (stack.length === len || stack[len] === ":" || stack[len] === "\n");
    if (constructor !== null && !looksNormal) return stack;

    let fallback = "Error";
    if (constructor === null) {
      const start =
        /^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/.exec(stack) || /^([a-z_A-Z0-9-]*Error)$/.exec(stack);
      fallback = (start && start[1]) || "";
      len = fallback.length;
      fallback = fallback || "Error";
    }
    const prefix = getPrefix(constructor, tag, fallback).slice(0, -1);
    if (name === prefix) return stack;
    if (!prefix.includes(name)) return `${prefix} [${name}]${stack.slice(len)}`;
    if (len === 0) return `${prefix}: ${stack}`;
    return `${prefix}${stack.slice(len)}`;
  }

  function removeDuplicateErrorKeys(ctx, keys, err, stack) {
    if (ctx.showHidden || keys.length === 0) return;
    for (const name of ["name", "message", "stack"]) {
      const index = keys.indexOf(name);
      // Only hide the property when it is part of the printed stack.
      if (index !== -1 && stack.includes(err[name])) keys.splice(index, 1);
    }
  }

  function formatError(err, constructor, tag, ctx, keys) {
    const name = err.name != null ? String(err.name) : "Error";
    let stack = getStackString(err);
    // Like Bun: a stack captured before `name` was assigned keeps "Error: ";
    // show the current name instead.
    stack = stack.replace(/^Error: /, `${name}${err.message ? ": " : ""}`);

    removeDuplicateErrorKeys(ctx, keys, err, stack);
    if ("cause" in err && !keys.includes("cause")) keys.push("cause");
    // Print errors aggregated into AggregateError.
    if (Array.isArray(err.errors) && !keys.includes("errors")) keys.push("errors");

    stack = improveStack(stack, constructor, name, tag);

    // Ignore the message when it is contained in the stack.
    let pos = (err.message && stack.indexOf(err.message)) || -1;
    if (pos !== -1) pos += err.message.length;
    const stackStart = stack.indexOf("\n    at", pos);
    if (stackStart === -1) {
      // No stack frames: wrap the error in brackets.
      stack = `[${stack}]`;
    } else {
      const lines = getStackFrames(ctx, err, stack.slice(stackStart + 1));
      const frames = ctx.colors ? lines.map(line => markNodeModules(ctx, line)) : lines;
      stack = `${stack.slice(0, stackStart)}\n${frames.join("\n")}`;
    }
    // The message and the stack have to be indented as well.
    if (ctx.indentationLvl !== 0) stack = stack.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
    return stack;
  }

  function markNodeModules(ctx, line) {
    const nodeModulesRegExp = /[/\\]node_modules[/\\](.+?)(?=[/\\])/g;
    let tempLine = "";
    let pos = 0;
    let nodeModule;
    while ((nodeModule = nodeModulesRegExp.exec(line)) !== null) {
      // '/node_modules/'.length === 14
      tempLine += line.slice(pos, nodeModule.index + 14);
      tempLine += ctx.stylize(nodeModule[1], "module");
      pos = nodeModule.index + nodeModule[0].length;
    }
    return pos === 0 ? line : tempLine + line.slice(pos);
  }

  // ---------------------------------------------------------------------------
  // Entry formatters
  // ---------------------------------------------------------------------------

  function groupArrayElements(ctx, output, value) {
    let totalLength = 0;
    let maxLength = 0;
    let outputLength = output.length;
    // Don't count the "... n more items" entry.
    if (ctx.maxArrayLength < output.length) outputLength--;
    const separatorSpace = 2; // comma + space
    const dataLen = new Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const len = getStringWidth(output[i], ctx.colors);
      dataLen[i] = len;
      totalLength += len + separatorSpace;
      if (maxLength < len) maxLength = len;
    }
    const actualMax = maxLength + separatorSpace;
    // Group only when at least three entries fit per line and no single entry
    // is much longer than the rest.
    if (actualMax * 3 + ctx.indentationLvl >= ctx.breakLength || (totalLength / actualMax <= 5 && maxLength > 6)) {
      return output;
    }
    const approxCharHeights = 2.5;
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      // Aim for a roughly square block of characters about 2.5x taller than wide.
      Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      ctx.compact * 4,
      15,
    );
    if (columns <= 1) return output;

    const maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j] > lineMaxLength) lineMaxLength = dataLen[j];
      }
      maxLineLength.push(lineMaxLength + separatorSpace);
    }
    // Numbers are right-aligned; anything else is left-aligned.
    let padStart = true;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== "number" && typeof value[i] !== "bigint") {
          padStart = false;
          break;
        }
      }
    }
    const tmp = [];
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let str = "";
      let j = i;
      for (; j < max - 1; j++) {
        // Account for invisible colour codes in the padding.
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += padStart ? `${output[j]}, `.padStart(padding, " ") : `${output[j]}, `.padEnd(padding, " ");
      }
      if (padStart) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
        str += output[j].padStart(padding, " ");
      } else {
        str += output[j];
      }
      tmp.push(str);
    }
    if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);
    return tmp;
  }

  function addNumericSeparator(integerString) {
    let result = "";
    let i = integerString.length;
    const start = integerString[0] === "-" ? 1 : 0;
    for (; i >= start + 4; i -= 3) result = `_${integerString.slice(i - 3, i)}${result}`;
    return i === integerString.length ? integerString : `${integerString.slice(0, i)}${result}`;
  }

  function addNumericSeparatorEnd(integerString) {
    let result = "";
    let i = 0;
    for (; i < integerString.length - 3; i += 3) result += `${integerString.slice(i, i + 3)}_`;
    return i === 0 ? integerString : `${result}${integerString.slice(i)}`;
  }

  const remainingText = remaining => `... ${remaining} more item${remaining > 1 ? "s" : ""}`;

  function formatNumber(fn, number, numericSeparator) {
    if (!numericSeparator) {
      // `${-0}` is "0", so -0 needs its own check.
      if (Object.is(number, -0)) return fn("-0", "number");
      return fn(`${number}`, "number");
    }
    const integer = Math.trunc(number);
    const string = String(integer);
    if (integer === number) {
      if (!Number.isFinite(number) || string.includes("e")) return fn(string, "number");
      return fn(addNumericSeparator(string), "number");
    }
    if (Number.isNaN(number)) return fn(string, "number");
    const fraction = String(number).slice(string.length + 1);
    return fn(`${addNumericSeparator(string)}.${addNumericSeparatorEnd(fraction)}`, "number");
  }

  function formatBigInt(fn, bigint, numericSeparator) {
    const string = String(bigint);
    if (!numericSeparator) return fn(`${string}n`, "bigint");
    return fn(`${addNumericSeparator(string)}n`, "bigint");
  }

  function formatPrimitive(fn, value, ctx) {
    if (typeof value === "string") return formatString(fn, value, ctx);
    if (typeof value === "number") return formatNumber(fn, value, ctx.numericSeparator);
    if (typeof value === "bigint") return formatBigInt(fn, value, ctx.numericSeparator);
    if (typeof value === "boolean") return fn(`${value}`, "boolean");
    if (typeof value === "undefined") return fn("undefined", "undefined");
    return fn(Symbol.prototype.toString.call(value), "symbol");
  }

  function formatString(fn, value, ctx) {
    let trailer = "";
    if (value.length > ctx.maxStringLength) {
      const remaining = value.length - ctx.maxStringLength;
      value = value.slice(0, ctx.maxStringLength);
      trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`;
    }
    const indentationLvl = ctx.indentationLvl;
    // Long strings are split on newlines into `'a\n' +` continuation lines.
    if (ctx.compact !== true && value.length > kMinLineLength && value.length > ctx.breakLength - indentationLvl - 4) {
      const lines = value.split(newLineSplitRegExp).map(line => fn(strEscape(line), "string"));
      return lines.join(` +\n${" ".repeat(indentationLvl + 2)}`) + trailer;
    }
    return fn(strEscape(value), "string") + trailer;
  }

  function formatNamespaceObject(keys, ctx, value, recurseTimes) {
    const output = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      try {
        output[i] = formatProperty(ctx, value, recurseTimes, keys[i], kObjectType);
      } catch (err) {
        if (!(err instanceof ReferenceError)) throw err;
        // Uninitialized binding: format a placeholder through the regular
        // path so indentation and line breaks stay right.
        const tmp = { [keys[i]]: "" };
        output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
        const pos = output[i].lastIndexOf(" ");
        output[i] = output[i].slice(0, pos + 1) + ctx.stylize("<uninitialized>", "special");
      }
    }
    // Prevent the keys from being printed a second time.
    keys.length = 0;
    return output;
  }

  // The array is sparse and/or has extra keys.
  function formatSpecialArray(ctx, value, recurseTimes, maxLength, output, i) {
    const keys = Object.keys(value);
    let index = i;
    for (; i < keys.length && output.length < maxLength; i++) {
      const key = keys[i];
      const tmp = +key;
      // Arrays can only have up to 2^32 - 1 entries.
      if (tmp > 2 ** 32 - 2) break;
      if (`${index}` !== key) {
        if (numberRegExp.exec(key) === null) break;
        const emptyItems = tmp - index;
        output.push(ctx.stylize(`<${emptyItems} empty item${emptyItems > 1 ? "s" : ""}>`, "undefined"));
        index = tmp;
        if (output.length === maxLength) break;
      }
      output.push(formatProperty(ctx, value, recurseTimes, key, kArrayType));
      index++;
    }
    const remaining = value.length - index;
    if (output.length !== maxLength) {
      if (remaining > 0) output.push(ctx.stylize(`<${remaining} empty item${remaining > 1 ? "s" : ""}>`, "undefined"));
    } else if (remaining > 0) {
      output.push(remainingText(remaining));
    }
    return output;
  }

  function formatArrayBuffer(ctx, value) {
    let buffer;
    try {
      buffer = new Uint8Array(value);
    } catch {
      return [ctx.stylize("(detached)", "special")];
    }
    let str = hexBytes(buffer, Math.min(ctx.maxArrayLength, buffer.length)).replace(/(.{2})/g, "$1 ").trim();
    const remaining = buffer.length - ctx.maxArrayLength;
    if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
    return [`${ctx.stylize("[Uint8Contents]", "special")}: <${str}>`];
  }

  function formatArray(ctx, value, recurseTimes) {
    const valLen = value.length;
    const len = Math.min(Math.max(0, ctx.maxArrayLength), valLen);
    const remaining = valLen - len;
    const output = [];
    for (let i = 0; i < len; i++) {
      // Sparse arrays take the slower path.
      if (!hasOwn(value, i)) return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
      output.push(formatProperty(ctx, value, recurseTimes, i, kArrayType));
    }
    if (remaining > 0) output.push(remainingText(remaining));
    return output;
  }

  function formatTypedArray(value, length, ctx) {
    // Buffers inspected without their custom inspector show at most 50 bytes.
    const limit = isBuffer(value) ? Math.min(ctx.maxArrayLength, INSPECT_MAX_BYTES) : ctx.maxArrayLength;
    const maxLength = Math.min(Math.max(0, limit), length);
    const remaining = length - maxLength;
    const output = new Array(maxLength);
    const elementFormatter = length > 0 && typeof value[0] === "number" ? formatNumber : formatBigInt;
    for (let i = 0; i < maxLength; ++i) output[i] = elementFormatter(ctx.stylize, value[i], ctx.numericSeparator);
    if (remaining > 0) output[maxLength] = remainingText(remaining);
    return output;
  }

  function formatSet(ctx, value, recurseTimes) {
    const length = setSize.call(value);
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
    const output = [];
    ctx.indentationLvl += 2;
    for (const entry of setValues.call(value)) {
      if (output.length >= maxLength) break;
      output.push(formatValue(ctx, entry, recurseTimes));
    }
    if (length - maxLength > 0) output.push(remainingText(length - maxLength));
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatMap(ctx, value, recurseTimes) {
    const length = mapSize.call(value);
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
    const output = [];
    ctx.indentationLvl += 2;
    for (const entry of mapEntries.call(value)) {
      if (output.length >= maxLength) break;
      output.push(`${formatValue(ctx, entry[0], recurseTimes)} => ${formatValue(ctx, entry[1], recurseTimes)}`);
    }
    if (length - maxLength > 0) output.push(remainingText(length - maxLength));
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatSetIterInner(ctx, recurseTimes, entries, state) {
    const maxLength = Math.min(Math.max(ctx.maxArrayLength, 0), entries.length);
    const output = new Array(maxLength);
    ctx.indentationLvl += 2;
    for (let i = 0; i < maxLength; i++) output[i] = formatValue(ctx, entries[i], recurseTimes);
    ctx.indentationLvl -= 2;
    if (state === kWeak && !ctx.sorted) output.sort();
    const remaining = entries.length - maxLength;
    if (remaining > 0) output.push(remainingText(remaining));
    return output;
  }

  // `entries` is flat: [key1, value1, key2, value2, ...].
  function formatMapIterInner(ctx, recurseTimes, entries, state) {
    const len = entries.length / 2;
    const maxLength = Math.min(Math.max(ctx.maxArrayLength, 0), len);
    const remaining = len - maxLength;
    const output = new Array(maxLength);
    ctx.indentationLvl += 2;
    for (let i = 0; i < maxLength; i++) {
      const key = formatValue(ctx, entries[i * 2], recurseTimes);
      const value = formatValue(ctx, entries[i * 2 + 1], recurseTimes);
      output[i] =
        state === kWeak
          ? `${key} => ${value}`
          : reduceToSingleString(ctx, [key, value], "", ["[", "]"], kArrayExtrasType, recurseTimes);
    }
    if (state === kWeak && !ctx.sorted) output.sort();
    ctx.indentationLvl -= 2;
    if (remaining > 0) output.push(remainingText(remaining));
    return output;
  }

  function formatWeakCollection(ctx) {
    return [ctx.stylize("<items unknown>", "special")];
  }

  // Map/Set iterators cannot be previewed without consuming them. The first
  // inspection drains the iterator through the intrinsic `next` and installs
  // an own, non-enumerable `next` that replays the buffered items, so later
  // consumers see the same sequence. Items added to the collection after the
  // first inspection are not seen by the iterator.
  const iteratorPreviews = new WeakMap();

  function previewIterator(iterator, type) {
    let state = iteratorPreviews.get(iterator);
    if (state === undefined) {
      const intrinsicNext = type === "Map" ? mapIteratorNext : setIteratorNext;
      const items = [];
      for (let step = intrinsicNext.call(iterator); !step.done; step = intrinsicNext.call(iterator)) {
        items.push(step.value);
      }
      state = { items, index: 0 };
      iteratorPreviews.set(iterator, state);
      const replay = state;
      Object.defineProperty(iterator, "next", {
        value: function next() {
          if (replay.index < replay.items.length) return { value: replay.items[replay.index++], done: false };
          return { value: undefined, done: true };
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    return state.items.slice(state.index);
  }

  // Whether the items came from an `entries()` iterator. The iterator kind is
  // not observable, so this is inferred from the item shape.
  function looksLikeEntries(items, type) {
    if (items.length === 0) return type === "Map";
    return items.every(
      item => Array.isArray(item) && item.length === 2 && (type === "Map" || Object.is(item[0], item[1])),
    );
  }

  function formatIterator(braces, type, ctx, value, recurseTimes) {
    const items = previewIterator(value, type);
    if (looksLikeEntries(items, type)) {
      braces[0] = braces[0].replace(/ Iterator] {$/, " Entries] {");
      const flat = items.flat();
      return formatMapIterInner(ctx, recurseTimes, flat, kMapEntries);
    }
    return formatSetIterInner(ctx, recurseTimes, items, kIterator);
  }

  function formatPromise(ctx, value, recurseTimes) {
    const stateName = internal.promiseState(value);
    const state = stateName === "pending" ? kPending : stateName === "rejected" ? kRejected : kFulfilled;
    if (state === kPending) return [ctx.stylize("<pending>", "special")];
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, internal.promiseResult(value), recurseTimes);
    ctx.indentationLvl -= 2;
    return [state === kRejected ? `${ctx.stylize("<rejected>", "special")} ${str}` : str];
  }

  function formatExtraProperties(ctx, value, recurseTimes, key, typedArray) {
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, value[key], recurseTimes, typedArray);
    ctx.indentationLvl -= 2;
    return `${ctx.stylize(`[${key}]`, "string")}: ${str}`;
  }

  function formatGetter(ctx, desc, original, recurseTimes) {
    const label = desc.set !== undefined ? "Getter/Setter" : "Getter";
    const s = ctx.stylize;
    const sp = "special";
    const getters = ctx.getters;
    const shouldCall =
      getters &&
      (getters === true ||
        (getters === "get" && desc.set === undefined) ||
        (getters === "set" && desc.set !== undefined));
    if (!shouldCall) return s(`[${label}]`, sp);
    try {
      const tmp = desc.get.call(original);
      ctx.indentationLvl += 2;
      let str;
      if (tmp === null) {
        str = `${s(`[${label}:`, sp)} ${s("null", "null")}${s("]", sp)}`;
      } else if (typeof tmp === "object") {
        str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
      } else {
        str = `${s(`[${label}:`, sp)} ${formatPrimitive(s, tmp, ctx)}${s("]", sp)}`;
      }
      ctx.indentationLvl -= 2;
      return str;
    } catch (err) {
      return `${s(`[${label}:`, sp)} <Inspection threw (${err.message})>${s("]", sp)}`;
    }
  }

  function formatPropertyValue(ctx, desc, type, original, recurseTimes) {
    if (desc.value !== undefined) {
      const diff = ctx.compact !== true || type !== kObjectType ? 2 : 3;
      ctx.indentationLvl += diff;
      const str = formatValue(ctx, desc.value, recurseTimes);
      let extra = " ";
      if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) {
        extra = `\n${" ".repeat(ctx.indentationLvl)}`;
      }
      ctx.indentationLvl -= diff;
      return { str, extra };
    }
    if (desc.get !== undefined) return { str: formatGetter(ctx, desc, original, recurseTimes), extra: " " };
    if (desc.set !== undefined) return { str: ctx.stylize("[Setter]", "special"), extra: " " };
    return { str: ctx.stylize("undefined", "undefined"), extra: " " };
  }

  function formatProperty(ctx, value, recurseTimes, key, type, desc, original = value) {
    desc = desc || Object.getOwnPropertyDescriptor(value, key) || { value: value[key], enumerable: true };
    const { str, extra } = formatPropertyValue(ctx, desc, type, original, recurseTimes);
    if (type === kArrayType) return str;

    let name;
    if (typeof key === "symbol") {
      name = ctx.stylize(Symbol.prototype.toString.call(key).replace(strEscapeSequencesReplacer, escapeFn), "symbol");
    } else if (keyStrRegExp.exec(key) !== null) {
      name = key === "__proto__" ? "['__proto__']" : ctx.stylize(key, "name");
    } else {
      name = ctx.stylize(strEscape(key), "string");
    }
    if (desc.enumerable === false) name = `[${name}]`;
    return `${name}:${extra}${str}`;
  }

  // ---------------------------------------------------------------------------
  // Line layout
  // ---------------------------------------------------------------------------

  function isBelowBreakLength(ctx, output, start, base) {
    // Entries are separated by at least a comma, so start from output.length.
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) return false;
    for (const entry of output) {
      totalLength += ctx.colors ? entry.replace(/\u001B\[\d\d?m/g, "").length : entry.length;
      if (totalLength > ctx.breakLength) return false;
    }
    // Do not line up properties on the same line if `base` contains line breaks.
    return base === "" || !base.includes("\n");
  }

  function reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value) {
    const compact = ctx.compact;
    if (compact !== true) {
      if (typeof compact === "number" && compact >= 1) {
        const single = reduceCompactNumber(ctx, output, base, braces, extrasType, recurseTimes, value, compact);
        if (typeof single === "string") return single;
        output = single;
      }
      // One entry per line.
      const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
      return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
    }
    if (isBelowBreakLength(ctx, output, 0, base)) {
      return `${braces[0]}${base ? ` ${base}` : ""} ${output.join(", ")} ${braces[1]}`;
    }
    const indentation = " ".repeat(ctx.indentationLvl);
    // A long opening brace such as "Set {" forces the first entry onto the
    // next line so the entries line up.
    const ln = base === "" && braces[0].length === 1 ? " " : `${base ? ` ${base}` : ""}\n${indentation}  `;
    return `${braces[0]}${ln}${output.join(`,\n${indentation}  `)} ${braces[1]}`;
  }

  // For numeric `compact`: group array entries, then put up to `compact`
  // innermost levels on one line when they fit. Returns the single-line string,
  // or the (possibly grouped) output to print one entry per line.
  function reduceCompactNumber(ctx, output, base, braces, extrasType, recurseTimes, value, compact) {
    const entries = output.length;
    if (extrasType === kArrayExtrasType && entries > 6) output = groupArrayElements(ctx, output, value);
    // ctx.currentDepth is the deepest level reached inside this value.
    if (ctx.currentDepth - recurseTimes >= compact || entries !== output.length) return output;
    // Add 10 as constant to start next to all other factors that may reduce
    // `breakLength`.
    const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
    if (!isBelowBreakLength(ctx, output, start, base)) return output;
    const joinedOutput = output.join(", ");
    if (joinedOutput.includes("\n")) return output;
    return `${base ? `${base} ` : ""}${braces[0]} ${joinedOutput} ${braces[1]}`;
  }

  // ---------------------------------------------------------------------------
  // format / formatWithOptions
  // ---------------------------------------------------------------------------

  function hasBuiltInToString(value) {
    // A proxy's target is unreachable; avoid running its traps.
    if (isProxy(value)) return true;

    let hasOwnToString = hasOwn;
    let hasOwnToPrimitive = hasOwn;
    // Objects without `toString` and `Symbol.toPrimitive` count as built-in.
    if (typeof value.toString !== "function") {
      if (typeof value[Symbol.toPrimitive] !== "function") return true;
      if (hasOwn(value, Symbol.toPrimitive)) return false;
      hasOwnToString = () => false;
    } else if (hasOwn(value, "toString")) {
      return false;
    } else if (typeof value[Symbol.toPrimitive] !== "function") {
      hasOwnToPrimitive = () => false;
    } else if (hasOwn(value, Symbol.toPrimitive)) {
      return false;
    }

    // Find the prototype that owns `toString` / `Symbol.toPrimitive`.
    let pointer = value;
    do {
      pointer = Object.getPrototypeOf(pointer);
      if (pointer === null) return true;
    } while (!hasOwnToString(pointer, "toString") && !hasOwnToPrimitive(pointer, Symbol.toPrimitive));

    const descriptor = Object.getOwnPropertyDescriptor(pointer, "constructor");
    return descriptor !== undefined && typeof descriptor.value === "function" && builtInObjects.has(descriptor.value.name);
  }

  const firstErrorLine = error => String(error.message).split("\n", 1)[0];
  let circularErrorMessage;

  function tryStringify(arg) {
    try {
      return JSON.stringify(arg);
    } catch (err) {
      if (circularErrorMessage === undefined) {
        try {
          const a = {};
          a.a = a;
          JSON.stringify(a);
        } catch (circularError) {
          circularErrorMessage = firstErrorLine(circularError);
        }
      }
      if (err.name === "TypeError" && firstErrorLine(err) === circularErrorMessage) return "[Circular]";
      throw err;
    }
  }

  function format(...args) {
    return formatWithOptionsInternal(undefined, args);
  }

  function formatWithOptions(inspectOptions, ...args) {
    validateObject(inspectOptions, "inspectOptions");
    return formatWithOptionsInternal(inspectOptions, args);
  }

  function numericSeparatorOf(options) {
    return options && options.numericSeparator !== undefined
      ? options.numericSeparator
      : inspectDefaultOptions.numericSeparator;
  }

  const formatNumberNoColor = (number, options) => formatNumber(stylizeNoColor, number, numericSeparatorOf(options));
  const formatBigIntNoColor = (bigint, options) => formatBigInt(stylizeNoColor, bigint, numericSeparatorOf(options));

  // Formats the argument consumed by `%<code>`; undefined means the code is
  // not a placeholder.
  function formatPlaceholder(code, arg, inspectOptions) {
    switch (code) {
      case 115: // 's'
        if (typeof arg === "number") return formatNumberNoColor(arg, inspectOptions);
        if (typeof arg === "bigint") return formatBigIntNoColor(arg, inspectOptions);
        if (typeof arg !== "object" || arg === null || !hasBuiltInToString(arg)) return String(arg);
        return inspect(arg, Object.assign({}, inspectOptions, { compact: 3, colors: false, depth: 0 }));
      case 106: // 'j'
        return tryStringify(arg);
      case 100: // 'd'
        if (typeof arg === "bigint") return formatBigIntNoColor(arg, inspectOptions);
        if (typeof arg === "symbol") return "NaN";
        return formatNumberNoColor(Number(arg), inspectOptions);
      case 79: // 'O'
        return inspect(arg, inspectOptions);
      case 111: // 'o'
        return inspect(arg, Object.assign({}, inspectOptions, { showHidden: true, showProxy: true, depth: 4 }));
      case 105: // 'i'
        if (typeof arg === "bigint") return formatBigIntNoColor(arg, inspectOptions);
        if (typeof arg === "symbol") return "NaN";
        return formatNumberNoColor(Number.parseInt(arg), inspectOptions);
      case 102: // 'f'
        if (typeof arg === "symbol") return "NaN";
        return formatNumberNoColor(Number.parseFloat(arg), inspectOptions);
      case 99: // 'c': CSS is ignored outside browsers.
        return "";
      default:
        return undefined;
    }
  }

  const placeholderCodes = new Set([115, 106, 100, 79, 111, 105, 102, 99]);

  function formatWithOptionsInternal(inspectOptions, args) {
    const first = args[0];
    let a = 0;
    let str = "";
    let join = "";

    if (typeof first === "string") {
      if (args.length === 1) return first;
      let lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first.charCodeAt(i) !== 37) continue; // '%'
        const nextChar = first.charCodeAt(++i);
        if (nextChar === 37) {
          // '%%' prints a single '%'.
          str += first.slice(lastPos, i);
          lastPos = i + 1;
          continue;
        }
        if (a + 1 === args.length || !placeholderCodes.has(nextChar)) continue;
        const tempStr = formatPlaceholder(nextChar, args[++a], inspectOptions);
        if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
        str += tempStr;
        lastPos = i + 1;
      }
      if (lastPos !== 0) {
        a++;
        join = " ";
        if (lastPos < first.length) str += first.slice(lastPos);
      }
    }

    while (a < args.length) {
      const value = args[a];
      str += join;
      str += typeof value !== "string" ? inspect(value, inspectOptions) : value;
      join = " ";
      a++;
    }
    return str;
  }

  return { nodeInspect: inspect, nodeFormat: format, nodeFormatWithOptions: formatWithOptions };
}
  // @@NODE_INSPECT_END@@

  const node = typeof createNodeInspect === "function" ? createNodeInspect(internal) : fallbackNodeInspect();
  const nodeInspect = node.nodeInspect;
  const nodeFormat = node.nodeFormat;
  const nodeFormatWithOptions = node.nodeFormatWithOptions;

  // Used only if the util.inspect port is missing; keeps console.log working.
  function fallbackNodeInspect() {
    const inspect = (value, options) => bunInspect(value, options);
    const format = (...args) => formatArgs(args);
    const formatWithOptions = (options, ...args) => formatArgs(args);
    inspect.custom = INSPECT_CUSTOM;
    return { nodeInspect: inspect, nodeFormat: format, nodeFormatWithOptions: formatWithOptions };
  }

  function nodeInspectForCustom(value, options) {
    return nodeInspect(value, options);
  }

  bunInspect.custom = INSPECT_CUSTOM;

  return {
    bunInspect,
    formatArgs,
    formatError,
    nodeInspect,
    nodeFormat,
    nodeFormatWithOptions,
    parseStack,
    inspectCustom: INSPECT_CUSTOM,
  };
})
