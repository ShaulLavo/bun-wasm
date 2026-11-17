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

  type Inspect = (value: unknown, options?: object) => string;
  type InspectOptions = { depth?: number | null; breakLength?: number };

  // Node's URLSearchParams[util.inspect.custom] (lib/internal/url.js): `Name { 'k' => 'v' }`,
  // one entry per line once the entries are longer than the break length.
  function inspectParams(name: string, pairs: readonly Pair[], depth: number | null, options: InspectOptions | undefined, inspect: Inspect): string {
    if (typeof depth === "number" && depth < 0) return "[Object]";
    const inner = Object.assign({}, options, { depth: depth === null ? null : depth - 1 });
    const output = pairs.map(([key, value]) => `${inspect(key, inner)} => ${inspect(value, inner)}`);
    if (output.length === 0) return `${name} {}`;
    // oxlint-disable-next-line no-control-regex -- Colors are measured without their escape sequences.
    const length = output.reduce((total, item) => total + item.replace(/\u001b\[[0-9;]*m/g, "").length + 2, -2);
    const breakLength = typeof options?.breakLength === "number" ? options.breakLength : 80;
    if (length > breakLength) return `${name} {\n  ${output.join(",\n  ")} }`;
    return `${name} { ${output.join(", ")} }`;
  }

  return { toUSVString, initFromObject, convertMethodArgs, inspectParams };
})
