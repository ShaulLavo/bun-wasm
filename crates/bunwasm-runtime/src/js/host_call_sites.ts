(function () {
  "use strict";
  const defaultPrepare = Error.prepareStackTrace;
  const wrappers = new WeakMap<Function, NonNullable<ErrorConstructor["prepareStackTrace"]>>();
  let prepare = defaultPrepare;

  interface NativeCallSite extends BunWasm.StackCallSite {
    getEnclosingLineNumber?(): number | null;
    getEnclosingColumnNumber?(): number | null;
  }

  function programFrame(site: NativeCallSite) {
    const line = site.getEnclosingLineNumber?.();
    const column = site.getEnclosingColumnNumber?.();
    if (typeof line !== "number" || typeof column !== "number") return undefined;
    return !site.getFunctionName() && line === 1 && column === 1;
  }

  function adapt(site: NativeCallSite) {
    return new Proxy(site, {
      get(target, key) {
        if (key === "isToplevel") return () => !target.getFunctionName();
        // V8 includes the suspended module program among its async frames.
        if (key === "isAsync") return () => target.isAsync() && programFrame(target) !== true;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function wrap(value: ErrorConstructor["prepareStackTrace"]) {
    if (typeof value !== "function" || value === defaultPrepare) return value;
    const previous = wrappers.get(value);
    if (previous) return previous;
    const wrapped = function (this: unknown, error: object, sites: unknown) {
      return Reflect.apply(value, this, [error, Array.isArray(sites) ? sites.map(adapt) : sites]);
    };
    wrappers.set(value, wrapped);
    wrappers.set(wrapped, wrapped);
    return wrapped;
  }

  const descriptor = {
    __proto__: null,
    configurable: true,
    enumerable: false,
    get() { return prepare; },
    set(value: ErrorConstructor["prepareStackTrace"]) { prepare = wrap(value); },
  };
  Object.defineProperty(Error, "prepareStackTrace", descriptor);
  return {};
})
