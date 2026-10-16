(function (internal) {
  "use strict";
  const { native } = internal;
  const capture = Error.captureStackTrace;
  const defaultPrepare = Error.prepareStackTrace;
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
    constructor(frame) { this.#frame = frame; }
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
  }

  if (native.engine === "jsc") {
    internal.defineHidden(Error, {
      captureStackTrace: function captureStackTrace(target, constructorOpt) {
        capture(target, typeof constructorOpt === "function" ? constructorOpt : captureStackTrace);
        const prepare = Error.prepareStackTrace;
        if (typeof prepare !== "function" || prepare === defaultPrepare) return;
        const frames = internal.require("inspect").parseStack(target.stack);
        const stack = Reflect.apply(prepare, Error, [target, frames.map(frame => new CallSite(frame))]);
        Object.defineProperty(target, "stack", { value: stack, writable: true, configurable: true, enumerable: false });
      },
    });
  }
  return {};
})
