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
  // mapped back to their source, the runtime's own and native frames as they are. A frame with
  // no source (eval code, a `new Function` body) has no position: eval code prints as Bun's
  // `eval (unknown)`. Caller-origin checks read these frames as opaque, so they stay.
  const runtimeFrame = /^(.*?)@(bun-wasm:.*:\d+:\d+)$/;
  const nativeFrame = /^(.*)@\[native code\]$/;
  function jscFrameText(inspect: BunWasm.ConsoleInspector, line: string) {
    const runtime = runtimeFrame.exec(line);
    if (runtime) return topLevelCode.has(runtime[1]!) ? runtime[2]! : `${runtime[1]} (${runtime[2]})`;
    const nativeCode = nativeFrame.exec(line);
    if (nativeCode) return `${nativeCode[1] || "<anonymous>"} (native)`;
    const unlocated = /^(.*)@$/.exec(line);
    if (unlocated) return `${topLevelCode.has(unlocated[1]!) ? "eval" : unlocated[1]} (unknown)`;
    const frame = inspect.parseStack(line)[0];
    return frame ? inspect.frameText(frame) : "";
  }

  // Formatted frames by their raw text, and whole formatted stacks by theirs. Mapping a frame
  // asks the host for its source map and source line, which dominates a stack read, and the
  // answer changes only when a loaded source or position map does, so both caches empty when
  // native.sourceGeneration() moves.
  const frameTexts = new Map<string, string>();
  const stackTexts = new Map<string, string>();
  let frameGeneration = -1;

  function remember(cache: Map<string, string>, limit: number, key: string, text: string) {
    if (cache.size >= limit) cache.clear();
    cache.set(key, text);
    return text;
  }

  function cachedFrameText(inspect: BunWasm.ConsoleInspector, line: string) {
    return frameTexts.get(line) ?? remember(frameTexts, 4096, line, jscFrameText(inspect, line));
  }

  // The frames Bun would not show: the runtime's own, and native frames the runtime called, such
  // as the `apply` its event loop runs a callback through. A native frame called by user code,
  // like `forEach`, stays.
  // The runtime's tick pass is the one runtime frame Bun shows, as its processTicksAndRejections
  // builtin (bootstrap.js `tickPassFrame`); the native call it runs a callback through stays hidden.
  const tickPassLine = /^processTicksAndRejections@bun-wasm:/;
  function hiddenJscFrames(lines: readonly string[]) {
    const hidden = new Array<boolean | "tick pass">(lines.length);
    let callerHidden = false;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      if (tickPassLine.test(line)) {
        hidden[index] = "tick pass";
        callerHidden = true;
        continue;
      }
      hidden[index] = runtimeFrame.test(line) || callerHidden && nativeFrame.test(line);
      callerHidden = hidden[index] === true;
    }
    return hidden;
  }

  // The `\n    at` lines for JavaScriptCore's text. A hot run maps through changing revisions,
  // so it formats every frame afresh.
  function jscFrames(raw: string, hot: boolean) {
    const inspect = internal.require("inspect");
    const lines = raw.split("\n");
    const hidden = internal.showRuntimeFrames() ? undefined : hiddenJscFrames(lines);
    let frames = "";
    for (let index = 0; index < lines.length; index++) {
      if (hidden?.[index] === true) continue;
      if (hidden?.[index] === "tick pass") {
        frames += `\n    at ${internal.tickPassFrame}`;
        continue;
      }
      const line = lines[index]!;
      const text = hot ? jscFrameText(inspect, line) : cachedFrameText(inspect, line);
      if (text) frames += `\n    at ${text}`;
    }
    return frames;
  }

  // JavaScriptCore's own text (`name@file:line:column` lines, no header) in Bun's form: the
  // header, then one `    at` line per frame.
  function jscStack(target: object, raw: string) {
    const hot = Boolean(internal.hotRun);
    if (hot) {
      internal.hotErrorStacks.set(target, raw);
      return internal.stackHeader(target) + jscFrames(raw, true);
    }
    const generation = native.sourceGeneration();
    if (generation !== frameGeneration) {
      frameTexts.clear();
      stackTexts.clear();
      frameGeneration = generation;
    }
    const frames = stackTexts.get(raw) ?? remember(stackTexts, 256, raw, jscFrames(raw, false));
    return internal.stackHeader(target) + frames;
  }

  function defaultStack(target: object, raw: unknown) {
    if (native.engine === "quickjs") return Reflect.apply(defaultPrepare!, Error, [target, raw]);
    return native.engine === "jsc" && typeof raw === "string" ? jscStack(target, raw) : raw;
  }

  function capturedFrames(target: object, raw: unknown) {
    const inspect = internal.require("inspect");
    return native.engine === "spidermonkey" ? inspect.errorFrames(target, raw) : inspect.parseStack(raw);
  }

  // QuickJS applies Error.stackTraceLimit while it captures, before the default text drops the
  // runtime's frames, so a limit the runtime's frames filled printed no frame at all. The engine
  // captures `stackHeadroom` more frames than the program's limit, each capture records that
  // limit, and formatting keeps that many frames. A limit below one stays as it is: no stack.
  const stackHeadroom = 16;
  const captureLimits = new WeakMap<object, number>();
  let programLimit: unknown;

  function headroomApplies(value: unknown): value is number {
    return typeof value === "number" && value >= 1 && Number.isFinite(value);
  }

  function recordLimit(sites: unknown) {
    if (Array.isArray(sites) && headroomApplies(programLimit)) captureLimits.set(sites, Math.trunc(programLimit));
    return sites;
  }

  // A custom formatter receives as many CallSites as the program's limit allows.
  function limitedSites(sites: unknown) {
    if (!Array.isArray(sites)) return sites;
    const limit = captureLimits.get(sites);
    return limit === undefined ? sites : sites.slice(0, limit);
  }
  internal.capturedStackLimit = (sites: object) => captureLimits.get(sites);

  function installStackHeadroom() {
    const nativeLimit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")!;
    const engineLimit = (value: unknown) => headroomApplies(value) ? value + stackHeadroom : value;
    programLimit = nativeLimit.get!.call(Error);
    nativeLimit.set!.call(Error, engineLimit(programLimit));
    Object.defineProperty(Error, "stackTraceLimit", nullPrototypeDescriptor({
      __proto__: null,
      configurable: nativeLimit.configurable,
      enumerable: nativeLimit.enumerable,
      get(this: unknown) {
        nativeLimit.get!.call(this);
        return programLimit;
      },
      set(this: unknown, value: unknown) {
        nativeLimit.set!.call(this, engineLimit(value));
        programLimit = value;
      },
    }));
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
        : limitedSites(raw);
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
    nativePrepare!.set!.call(Error, (_error: object, sites: unknown) => recordLimit(sites));
    installStackHeadroom();
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
