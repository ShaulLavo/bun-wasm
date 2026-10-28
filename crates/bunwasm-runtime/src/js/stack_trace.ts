(function (internal: BunWasm.Internal) {
  "use strict";
  const { native } = internal;
  const capture = Error.captureStackTrace;
  const defaultPrepare = Error.prepareStackTrace;
  const formatted = new WeakMap<object, unknown>();
  let formatting = false;
  type NullPrototypeDescriptor = PropertyDescriptor & { __proto__: null };
  function nullPrototypeDescriptor(descriptor: NullPrototypeDescriptor): PropertyDescriptor {
    return descriptor;
  }

  function store(target: object, value: unknown) {
    formatted.set(target, value);
    if (formatting) return value;
    const own = Object.getOwnPropertyDescriptor(target, "stack");
    if (own ? own.configurable : Object.isExtensible(target)) {
      Object.defineProperty(target, "stack", nullPrototypeDescriptor({ __proto__: null, value, writable: true, configurable: true, enumerable: false }));
    }
    return value;
  }

  function validateCaptureTarget(target: object) {
    if (!Object.isExtensible(target)) throw new TypeError("Cannot capture stack on a non-extensible target");
    if (Object.getOwnPropertyDescriptor(target, "stack")?.configurable === false) {
      throw new TypeError("Cannot redefine non-configurable stack");
    }
  }

  const methods = {
    getThis() { return undefined; },
    getTypeName() { return null; },
    getMethodName() { return null; },
    getScriptNameOrSourceURL(this: BunWasm.StackCallSite) { return this.getFileName(); },
    isEval(this: BunWasm.StackCallSite) { return /^(?:<input>|<eval>)$/.test(this.getFileName()); },
    getEvalOrigin() { return undefined; },
    // Bun answers from the callee and the frame's strictness: a sloppy function call is not
    // top-level. Neither engine's frames here carry strictness, so only program code (no
    // function name) is top-level; a strict function frame, which Bun calls top-level, reads false.
    isToplevel(this: BunWasm.StackCallSite) { return !this.getFunctionName(); },
    // Neither engine reports Promise.all/any combinator frames.
    isPromiseAll() { return false; },
    getPromiseIndex() { return null; },
    toString(this: BunWasm.StackCallSite) { return internal.formatCallSite(this); },
  } satisfies ThisType<BunWasm.StackCallSite>;

  class CallSite {
    #frame: BunWasm.StackFrame;
    constructor(frame: BunWasm.StackFrame) { this.#frame = frame; internal.mappedCallSites.add(this); }
    getFileName() { return this.#frame.file; }
    getFunctionName() { return this.#frame.name || null; }
    getFunction() { return undefined; }
    getLineNumber() { return this.#frame.line; }
    getColumnNumber() { return this.#frame.column; }
    isNative() { return false; }
    isConstructor() { return this.#frame.name.startsWith("new "); }
    // JavaScriptCore names the frames of suspended awaiting callers `async <name>`.
    isAsync() { return this.#frame.name.startsWith("async "); }
  }
  internal.defineHidden(CallSite.prototype, methods);

  function defaultStack(target: object, raw: unknown) {
    return native.engine === "quickjs" ? Reflect.apply(defaultPrepare!, Error, [target, raw]) : raw;
  }

  function formatStack(target: object, raw: unknown) {
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
    const holder: { stack?: BunWasm.StackCallSite[] } = {};
    Error.prepareStackTrace = (error, sites) => sites;
    capture(holder);
    Error.prepareStackTrace = defaultPrepare;
    const prototype = Object.getPrototypeOf(holder.stack![0]);
    internal.defineHidden(prototype, methods);
    // QuickJS walks only live frames, so a suspended awaiting caller never appears: none of the
    // frames it reports is an async frame.
    internal.defineHidden(prototype, { isAsync() { return false; } });
    const nativeStack = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
    const nativePrepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    nativePrepare!.set!.call(Error, (_error: object, sites: unknown) => sites);
    Object.defineProperty(Error, "prepareStackTrace", { value: defaultPrepare, writable: true, configurable: true });

    Object.defineProperty(Error.prototype, "stack", {
      configurable: true,
      get() {
        if (formatted.has(this)) return formatted.get(this);
        const sites = nativeStack!.get!.call(this);
        if (!Array.isArray(sites)) return sites;
        return formatStack(this, sites);
      },
      set(value: unknown) { store(this, value); },
    });
  }

  if (native.engine === "quickjs" || native.engine === "jsc") {
    internal.defineHidden(Error, {
      captureStackTrace: function captureStackTrace(target: { stack?: unknown }, constructorOpt?: unknown) {
        validateCaptureTarget(target);
        capture(target, typeof constructorOpt === "function" ? constructorOpt : captureStackTrace);
        formatted.delete(target);
        const raw = target.stack;
        Object.defineProperty(target, "stack", nullPrototypeDescriptor({
          __proto__: null,
          configurable: true,
          enumerable: false,
          get() { return formatStack(this, raw); },
          set(value: unknown) { store(this, value); },
        }));
      },
    });
  }
  return {};
})
