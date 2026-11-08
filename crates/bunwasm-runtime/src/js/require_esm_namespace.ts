(function () {
  "use strict";
  const namespaces = new WeakMap<object, object>();
  const prototype: object = Object.create(null);
  Object.defineProperty(prototype, "__esModule", { value: true });

  return function requireEsmNamespace(exports: object): object {
    if (Reflect.has(exports, "__esModule")) return exports;
    const cached = namespaces.get(exports);
    if (cached) return cached;
    const namespace: object = Object.create(prototype);
    for (const key of Reflect.ownKeys(exports)) {
      Object.defineProperty(namespace, key, {
        get: () => Reflect.get(exports, key),
        enumerable: typeof key === "string",
      });
    }
    Object.preventExtensions(namespace);
    namespaces.set(exports, namespace);
    return namespace;
  };
})
