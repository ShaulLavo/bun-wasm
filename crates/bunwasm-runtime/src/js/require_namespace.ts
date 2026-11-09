(function () {
  "use strict";
  const namespaces = new WeakMap<object, Record<string, unknown>>();

  return function commonJsNamespace(value: unknown): Record<string, unknown> {
    const isObject = value !== null && (typeof value === "object" || typeof value === "function");
    const cached = isObject ? namespaces.get(value) : undefined;
    if (cached) return cached;
    const namespace: Record<string, unknown> = Object.create(null);
    Object.defineProperty(namespace, "default", { value, enumerable: true });
    if (!isObject) return namespace;
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "default") continue;
      Object.defineProperty(namespace, key, { get: () => Reflect.get(value, key), enumerable: true });
    }
    namespaces.set(value, namespace);
    return namespace;
  };
})
