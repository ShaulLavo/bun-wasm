(function (internal) {
  "use strict";
  const { native } = internal;
  const capture = Error.captureStackTrace;
  const defaultPrepare = Error.prepareStackTrace;
  const formatted = new WeakMap();
  let formatting = false;

  function store(target, value) {
    formatted.set(target, value);
    if (formatting) return value;
    const own = Object.getOwnPropertyDescriptor(target, "stack");
    if (own ? own.configurable : Object.isExtensible(target)) {
      // Null-prototype descriptors: an inherited Object.prototype.get must not turn them into accessors.
      Object.defineProperty(target, "stack", { __proto__: null, value, writable: true, configurable: true, enumerable: false });
    }
    return value;
  }

  function validateCaptureTarget(target) {
    if (!Object.isExtensible(target)) throw new TypeError("Cannot capture stack on a non-extensible target");
    if (Object.getOwnPropertyDescriptor(target, "stack")?.configurable === false) {
      throw new TypeError("Cannot redefine non-configurable stack");
    }
  }

  const methods = {
    getThis() { return undefined; },
    getTypeName() { return null; },
    getMethodName() { return null; },
    getScriptNameOrSourceURL() { return this.getFileName(); },
    isEval() { return /^(?:<input>|<eval>)$/.test(this.getFileName()); },
    getEvalOrigin() { return undefined; },
    toString() { return internal.formatCallSite(this); },
  };

  class CallSite {
    #frame;
    constructor(frame) { this.#frame = frame; internal.mappedCallSites.add(this); }
    getFileName() { return this.#frame.file; }
    getFunctionName() { return this.#frame.name || null; }
    getFunction() { return undefined; }
    getLineNumber() { return this.#frame.line; }
    getColumnNumber() { return this.#frame.column; }
    isNative() { return false; }
    isConstructor() { return this.#frame.name.startsWith("new "); }
    isToplevel() { return !this.#frame.name; }
  }
  internal.defineHidden(CallSite.prototype, methods);

  function defaultStack(target, raw) {
    return native.engine === "quickjs" ? Reflect.apply(defaultPrepare, Error, [target, raw]) : raw;
  }

  function formatStack(target, raw) {
    if (formatted.has(target)) return formatted.get(target);
    if (formatting) return store(target, defaultStack(target, raw));
    formatting = true;
    let value;
    try {
      const prepare = Error.prepareStackTrace;
      const custom = typeof prepare === "function" && prepare !== defaultPrepare;
      const sites = custom && native.engine === "jsc"
        ? internal.require("inspect").parseStack(raw).map(frame => new CallSite(frame))
        : raw;
      value = custom ? Reflect.apply(prepare, Error, [target, sites]) : defaultStack(target, raw);
    } finally {
      formatting = false;
    }
    return store(target, value);
  }

  if (native.engine === "quickjs") {
    const holder = {};
    Error.prepareStackTrace = (error, sites) => sites;
    capture(holder);
    Error.prepareStackTrace = defaultPrepare;
    const prototype = Object.getPrototypeOf(holder.stack[0]);
    internal.defineHidden(prototype, methods);
    const nativeStack = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
    const nativePrepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    nativePrepare.set.call(Error, (_error, sites) => sites);
    Object.defineProperty(Error, "prepareStackTrace", { value: defaultPrepare, writable: true, configurable: true });

    Object.defineProperty(Error.prototype, "stack", {
      configurable: true,
      get() {
        if (formatted.has(this)) return formatted.get(this);
        const sites = nativeStack.get.call(this);
        if (!Array.isArray(sites)) return sites;
        return formatStack(this, sites);
      },
      set(value) { store(this, value); },
    });
  }

  if (native.engine === "quickjs" || native.engine === "jsc") {
    internal.defineHidden(Error, {
      captureStackTrace: function captureStackTrace(target, constructorOpt) {
        validateCaptureTarget(target);
        capture(target, typeof constructorOpt === "function" ? constructorOpt : captureStackTrace);
        formatted.delete(target);
        const raw = target.stack;
        Object.defineProperty(target, "stack", {
          __proto__: null,
          configurable: true,
          enumerable: false,
          get() { return formatStack(this, raw); },
          set(value) { store(this, value); },
        });
      },
    });
  }
  return {};
})
