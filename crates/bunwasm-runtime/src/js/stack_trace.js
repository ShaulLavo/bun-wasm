(function (internal) {
  "use strict";
  const { native } = internal;
  const capture = Error.captureStackTrace;
  const defaultPrepare = Error.prepareStackTrace;
  const formatted = new WeakMap();

  function store(target, value) {
    formatted.set(target, value);
    const own = Object.getOwnPropertyDescriptor(target, "stack");
    if (own ? own.configurable : Object.isExtensible(target)) {
      Object.defineProperty(target, "stack", { value, writable: true, configurable: true, enumerable: false });
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

    function format(target, sites) {
      if (!Array.isArray(sites)) return sites;
      const prepare = Error.prepareStackTrace;
      return Reflect.apply(typeof prepare === "function" ? prepare : defaultPrepare, Error, [target, sites]);
    }
    Object.defineProperty(Error.prototype, "stack", {
      configurable: true,
      get() {
        if (formatted.has(this)) return formatted.get(this);
        const sites = nativeStack.get.call(this);
        if (!Array.isArray(sites)) return sites;
        const value = format(this, sites);
        store(this, value);
        return value;
      },
      set(value) { store(this, value); },
    });
    internal.defineHidden(Error, {
      captureStackTrace: function captureStackTrace(target, constructorOpt) {
        validateCaptureTarget(target);
        capture(target, typeof constructorOpt === "function" ? constructorOpt : captureStackTrace);
        formatted.delete(target);
        const sites = target.stack;
        Object.defineProperty(target, "stack", {
          configurable: true,
          enumerable: false,
          get() {
            if (formatted.has(this)) return formatted.get(this);
            const value = format(this, sites);
            store(this, value);
            return value;
          },
          set(value) { store(this, value); },
        });
      },
    });
  }

  if (native.engine === "jsc") {
    internal.defineHidden(Error, {
      captureStackTrace: function captureStackTrace(target, constructorOpt) {
        validateCaptureTarget(target);
        capture(target, typeof constructorOpt === "function" ? constructorOpt : captureStackTrace);
        formatted.delete(target);
        const raw = target.stack;
        Object.defineProperty(target, "stack", {
          configurable: true,
          enumerable: false,
          get() {
            if (formatted.has(this)) return formatted.get(this);
            const prepare = Error.prepareStackTrace;
            const value = typeof prepare === "function" && prepare !== defaultPrepare
              ? Reflect.apply(prepare, Error, [this, internal.require("inspect").parseStack(raw).map(frame => new CallSite(frame))])
              : raw;
            return store(this, value);
          },
          set(value) { store(this, value); },
        });
      },
    });
  }
  return {};
})
