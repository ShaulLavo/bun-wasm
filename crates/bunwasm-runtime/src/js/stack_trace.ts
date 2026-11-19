(function (internal: BunWasm.Internal) {
  "use strict";
  const { native } = internal;
  const capture = Error.captureStackTrace;
  // JavaScriptCore and SpiderMonkey capture stack text natively and never consult the formatter.
  const parseCapturedStack = native.engine === "jsc" || native.engine === "spidermonkey" || native.engine === "host" && !internal.hasNativeStackTrace;
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
  } satisfies ThisType<BunWasm.StackCallSite>;

  class CallSite {
    declare isToplevel: typeof methods.isToplevel;
    declare isPromiseAll: typeof methods.isPromiseAll;
    declare getPromiseIndex: typeof methods.getPromiseIndex;
    #frame: BunWasm.StackFrame;
    constructor(frame: BunWasm.StackFrame) { this.#frame = frame; internal.mappedCallSites.add(this); }
    getFileName() { return this.#frame.file; }
    getFunctionName() { return this.#frame.name || null; }
    getFunction() { return undefined; }
    getLineNumber() { return this.#frame.line; }
    getColumnNumber() { return this.#frame.column; }
    toString() { return internal.formatCallSite(this, false, this.#frame.anonymousFunction === true); }
    isNative() { return false; }
    isConstructor() { return this.#frame.name.startsWith("new "); }
    // Suspended awaiting callers are named `async <name>` by JavaScriptCore and `async*<name>`
    // by SpiderMonkey.
    isAsync() { return /^async[ *]/.test(this.#frame.name); }
  }
  internal.defineHidden(CallSite.prototype, methods);

  const topLevelCode = new Set(["", "global code", "module code", "eval code", "__bunwasm_cjs__"]);

  // One line of JavaScriptCore's text as QuickJS's formatter prints it: application frames
  // mapped back to their source, the runtime's own and native frames as they are.
  function jscFrameText(inspect: BunWasm.ConsoleInspector, line: string) {
    const runtime = /^(.*?)@(bun-wasm:.*:\d+:\d+)$/.exec(line);
    if (runtime) return topLevelCode.has(runtime[1]!) ? runtime[2] : `${runtime[1]} (${runtime[2]})`;
    const nativeCode = /^(.*)@\[native code\]$/.exec(line);
    if (nativeCode) return `${nativeCode[1] || "<anonymous>"} (native)`;
    const frame = inspect.parseStack(line)[0];
    return frame && inspect.frameText(frame);
  }

  // JavaScriptCore's own text (`name@file:line:column` lines, no header) in Bun's form: the
  // header, then one `    at` line per frame.
  function jscStack(target: object, raw: string) {
    if (internal.hotRun) internal.hotErrorStacks.set(target, raw);
    const inspect = internal.require("inspect");
    const lines = [internal.stackHeader(target)];
    for (const line of raw.split("\n")) {
      const text = jscFrameText(inspect, line);
      if (text) lines.push(`    at ${text}`);
    }
    return lines.join("\n");
  }

  function defaultStack(target: object, raw: unknown) {
    if (native.engine === "quickjs") return Reflect.apply(defaultPrepare!, Error, [target, raw]);
    return native.engine === "jsc" && typeof raw === "string" ? jscStack(target, raw) : raw;
  }

  function capturedFrames(target: object, raw: unknown) {
    const inspect = internal.require("inspect");
    return native.engine === "spidermonkey" ? inspect.errorFrames(target, raw) : inspect.parseStack(raw);
  }

  function formatStack(target: object, raw: unknown, materializing = false) {
    if (formatted.has(target)) return formatted.get(target);
    if (formatting) return store(target, defaultStack(target, raw));
    formatting = true;
    let value;
    try {
      const prepare = Error.prepareStackTrace;
      const custom = typeof prepare === "function" && prepare !== defaultPrepare;
      if (!custom && materializing) return defaultStack(target, raw);
      const sites = custom && parseCapturedStack
        ? capturedFrames(target, raw).map(frame => new CallSite(frame))
        : raw;
      value = custom ? Reflect.apply(prepare, Error, [target, sites]) : defaultStack(target, raw);
    } finally {
      formatting = false;
    }
    return store(target, value);
  }

  if (native.engine === "jsc") {
    Object.defineProperty(globalThis, Symbol.for("bunwasm.internal.jsc.formatStack"), nullPrototypeDescriptor({
      __proto__: null, value: (target: object, raw: unknown) => formatStack(target, raw, true),
    }));
  }

  if (native.engine === "host" && internal.hasNativeStackTrace) {
    internal.require("host_call_sites");
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
    internal.defineHidden(prototype, {
      isAsync() { return false; },
      toString(this: BunWasm.StackCallSite) { return internal.formatCallSite(this); },
    });
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

  if (native.engine === "spidermonkey") {
    const nativeStack = Object.getOwnPropertyDescriptor(Error.prototype, "stack")!;
    Object.defineProperty(Error.prototype, "stack", nullPrototypeDescriptor({
      __proto__: null,
      configurable: nativeStack.configurable,
      enumerable: nativeStack.enumerable,
      get() {
        const raw = nativeStack.get!.call(this);
        return raw ? formatStack(this, raw) : raw;
      },
      set: nativeStack.set,
    }));
  }

  if (native.engine === "quickjs" || parseCapturedStack) {
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
