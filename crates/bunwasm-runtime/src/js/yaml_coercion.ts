(function () {
  "use strict";
  const isPrimitive = (value: unknown) => value === null || typeof value !== "object" && typeof value !== "function";
  function primitive(value: object, hint: "string" | "number"): unknown {
    const exotic: unknown = Reflect.get(value, Symbol.toPrimitive);
    if (exotic != null) {
      if (typeof exotic !== "function") throw new TypeError("Symbol.toPrimitive is not a function");
      const result: unknown = Reflect.apply(exotic, value, [hint]);
      if (!isPrimitive(result)) throw new TypeError("Symbol.toPrimitive returned an object");
      return result;
    }
    const methods = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
    for (const key of methods) {
      const method: unknown = Reflect.get(value, key);
      if (typeof method !== "function") continue;
      const result: unknown = Reflect.apply(method, value, []);
      if (isPrimitive(result)) return result;
    }
    throw new TypeError("Cannot convert object to primitive value");
  }
  return function unbox(value: unknown): unknown {
    if (value instanceof String) {
      const result = primitive(value, "string");
      if (typeof result === "symbol") throw new TypeError("Cannot convert a symbol to a string");
      return String(result);
    }
    if (value instanceof Number) {
      const result = primitive(value, "number");
      if (typeof result === "symbol") throw new TypeError("Cannot convert a symbol to a number");
      if (typeof result === "bigint") throw new TypeError("Cannot convert a BigInt value to a number");
      return Number(result);
    }
    if (value instanceof Boolean) return Reflect.apply(Boolean.prototype.valueOf, value, []);
    return value;
  };
})
