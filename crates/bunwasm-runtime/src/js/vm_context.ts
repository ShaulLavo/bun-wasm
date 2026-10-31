(function (internal: BunWasm.Internal) {
  "use strict";

  // Engines without `with` run context code through prepareContextScript: every reference the
  // source leaves free reads a member of `scope`, which resolves it the way `with (context)` would,
  // at each evaluation: the context (own or inherited) first, then the host global.
  function scopes(context: object, host: typeof globalThis): [scope: object, typeofScope: object] {
    const owner = (name: string | symbol) => name in context ? context : host;
    const scope: object = new Proxy(Object.create(null), {
      get(_target, name, receiver) {
        if (name in context) return Reflect.get(context, name, context);
        if (name in host || receiver === typeofScope) return Reflect.get(host, name, host);
        throw new ReferenceError(`${String(name)} is not defined`);
      },
      set: (_target, name, value) => Reflect.set(owner(name), name, value),
      deleteProperty: (_target, name) => Reflect.deleteProperty(owner(name), name),
    });
    // `typeof missing` is "undefined": reads through this object reach `get` with it as receiver.
    const typeofScope: object = Object.create(scope);
    return [scope, typeofScope];
  }

  function run(code: string, context: object, filename: string): unknown {
    const runner: unknown = internal.native.evalScript(internal.prepareContextScript(code, filename), filename, 0);
    if (typeof runner !== "function") throw new TypeError(`context script ${filename} did not compile to a function`);
    return Reflect.apply(runner, globalThis, scopes(context, globalThis));
  }

  return { run };
})
