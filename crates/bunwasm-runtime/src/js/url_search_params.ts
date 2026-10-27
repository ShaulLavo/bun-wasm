(function () {
  "use strict";
  type Pair = [string, string];

  function toUSVString(value: unknown): string {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, part => part.length === 2 ? part : "\uFFFD");
  }

  function convertMethodArgs(readList: () => Pair[], name: unknown, value?: unknown, requiredValue = false): [string, string | undefined] {
    readList();
    const key = toUSVString(name);
    const converted = value === undefined && !requiredValue ? undefined : toUSVString(value);
    return [key, converted];
  }

  function sequence(value: object, iterator: Function): Iterable<unknown> {
    return { [Symbol.iterator]: () => Reflect.apply(iterator, value, []) };
  }

  function convertPair(value: unknown): string[] {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      throw Object.assign(new TypeError("Value is not a sequence"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const iterator: unknown = Reflect.get(value, Symbol.iterator);
    if (typeof iterator !== "function") throw new TypeError("Type error");
    return Array.from(sequence(value, iterator), toUSVString);
  }

  function checkedPair(value: string[]): Pair {
    if (value.length !== 2) throw new TypeError("Type error");
    return [value[0], value[1]];
  }

  function initFromObject(init: object): Pair[] {
    const iterator: unknown = Reflect.get(init, Symbol.iterator);
    if (iterator != null) {
      if (typeof iterator !== "function") throw new TypeError("Symbol.iterator property should be callable");
      return Array.from(sequence(init, iterator), convertPair).map(checkedPair);
    }
    const entries = new Map<string, string>();
    for (const key of Reflect.ownKeys(init)) {
      if (!Object.prototype.propertyIsEnumerable.call(init, key)) continue;
      if (typeof key === "symbol") throw new TypeError("Cannot convert a symbol to a string");
      entries.set(toUSVString(key), toUSVString(Reflect.get(init, key)));
    }
    return Array.from(entries);
  }

  return { toUSVString, initFromObject, convertMethodArgs };
})
