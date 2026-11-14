interface BufferFactory {
  alloc(size: number, fill?: number): Uint8Array;
  from(value: string, encoding?: "hex"): Uint8Array;
  from(value: ArrayBuffer): Uint8Array;
  prototype: object;
}

type Check = { name: string; run(): void };

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function codeOf(callback: () => unknown): unknown {
  try { callback(); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) return error.code;
    throw error;
  }
  return "DID NOT THROW";
}

function typeError(callback: () => unknown): void {
  try { callback(); } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error && error.name === "TypeError") return;
    throw error;
  }
  throw new Error("Expected TypeError");
}

function call(receiver: unknown, prototype: object, method: string, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(prototype, method);
  if (typeof fn !== "function") throw new Error(`Missing ${method}`);
  return Reflect.apply(fn, receiver, args);
}

function bytes(value: Uint8Array) { return Array.from(value); }

function detached(Buffer: BufferFactory) {
  const ab = new ArrayBuffer(9);
  const buf = Buffer.from(ab);
  structuredClone(ab, { transfer: [ab] });
  return buf;
}

export function encodingChecks(Buffer: BufferFactory): Check[] {
  const checks: Check[] = [];
  const add = (name: string, run: () => void) => checks.push({ name, run });
  const invoke = (buf: unknown, method: string, ...args: unknown[]) => call(buf, Buffer.prototype, method, ...args);
  const definitions = [
    { prefix: "utf8", text: "hello", strict: true, output: [104, 101, 108, 108, 111] },
    { prefix: "latin1", text: "hello", strict: true, output: [104, 101, 108, 108, 111] },
    { prefix: "ascii", text: "hello", strict: true, output: [104, 101, 108, 108, 111] },
    { prefix: "ucs2", text: "hello", strict: false, output: [104, 0, 101, 0, 108, 0, 108, 0] },
    { prefix: "utf16le", text: "hello", strict: false, output: [104, 0, 101, 0, 108, 0, 108, 0] },
    { prefix: "base64", text: "aGVsbG8=", strict: false, output: [104, 101, 108, 108, 111] },
    { prefix: "base64url", text: "aGVsbG8", strict: false, output: [104, 101, 108, 108, 111] },
    { prefix: "hex", text: "68656c6c6f", strict: false, output: [104, 101, 108, 108, 111] },
  ];
  for (const { prefix, text, strict, output } of definitions) {
    const method = `${prefix}Write`, slice = `${prefix}Slice`;
    add(`${method} validates bounds with its own policy`, () => {
      const buf = Buffer.alloc(9, 0xcc);
      equal(codeOf(() => invoke(buf, method, text, -1)), strict ? "ERR_BUFFER_OUT_OF_BOUNDS" : "ERR_OUT_OF_RANGE");
      equal(codeOf(() => invoke(buf, method, text, 0, -1)), strict ? "ERR_BUFFER_OUT_OF_BOUNDS" : "ERR_OUT_OF_RANGE");
      equal(codeOf(() => invoke(buf, method, text, 10)), "ERR_BUFFER_OUT_OF_BOUNDS");
      equal(codeOf(() => invoke(buf, method, text, Infinity)), "ERR_BUFFER_OUT_OF_BOUNDS");
      if (strict) equal(codeOf(() => invoke(buf, method, text, 6, 1000)), "ERR_BUFFER_OUT_OF_BOUNDS");
      if (!strict) equal(invoke(buf, method, text, 6, 1000), prefix.includes("16") || prefix === "ucs2" ? 2 : 3);
    });
    add(`${method} converts NaN without returning NaN`, () => {
      const buf = Buffer.alloc(9, 0xcc);
      equal(invoke(buf, method, text, 0, NaN), 0);
      equal(invoke(buf, method, text, NaN), strict ? 0 : output.length);
      if (!strict) equal(bytes(buf).slice(0, output.length), output);
      equal(invoke(buf, method, text, NaN, 2), 2);
    });
    add(`${method} rejects nonstrings without touching them`, () => {
      const buf = Buffer.alloc(9, 0xcc);
      const value = new Proxy({}, { get() { throw new Error("read nonstring"); } });
      const values: unknown[] = [123, null, undefined, true, 1n, Symbol("s"), value, [], new String("ab")];
      for (const input of values) equal(codeOf(() => invoke(buf, method, input)), "ERR_INVALID_ARG_TYPE");
      equal(bytes(buf), Array(9).fill(0xcc));
    });
    add(`${method} preserves validation order`, () => {
      const buf = Buffer.alloc(9);
      equal(codeOf(() => invoke(buf, method, 123, -1)), strict ? "ERR_BUFFER_OUT_OF_BOUNDS" : "ERR_INVALID_ARG_TYPE");
      const converted: string[] = [];
      const offset = { valueOf() { converted.push("offset"); return 0; } };
      const length = { valueOf() { converted.push("length"); return 1; } };
      equal(codeOf(() => invoke(buf, method, 123, offset, length)), "ERR_INVALID_ARG_TYPE");
      equal(converted, strict ? ["offset", "length"] : []);
    });
    add(`${method} handles empty and detached views`, () => {
      const buf = detached(Buffer);
      equal(invoke(buf, method, text), 0);
      equal(invoke(buf, method, text, NaN), 0);
      equal(invoke(buf, method, text, 0, NaN), 0);
      equal(codeOf(() => invoke(buf, method, text, 1)), "ERR_BUFFER_OUT_OF_BOUNDS");
      equal(codeOf(() => invoke(buf, method, 123)), "ERR_INVALID_ARG_TYPE");
    });
    add(`${method} handles detachment during argument conversion`, () => {
      const ab = new ArrayBuffer(9), buf = Buffer.from(ab);
      const offset = { valueOf() { structuredClone(ab, { transfer: [ab] }); return 5; } };
      if (strict) equal(codeOf(() => invoke(buf, method, text, offset)), "ERR_BUFFER_OUT_OF_BOUNDS");
      if (strict) return;
      typeError(() => invoke(buf, method, text, offset));
    });
    add(`${slice} checks raw ranges`, () => {
      const buf = Buffer.from("68656c6c6f21", "hex");
      equal(invoke(buf, slice, 7), "");
      equal(invoke(buf, slice, 7, 3), "");
      equal(invoke(buf, slice, 0, NaN), "");
      equal(codeOf(() => invoke(buf, slice, 0, 7)), "ERR_OUT_OF_RANGE");
      equal(codeOf(() => invoke(buf, slice, 0, Infinity)), "ERR_OUT_OF_RANGE");
      equal(codeOf(() => invoke(buf, slice, -1)), "ERR_OUT_OF_RANGE");
      equal(codeOf(() => invoke(buf, slice, 0, -1)), "ERR_OUT_OF_RANGE");
    });
  }
  add("raw helpers accept byte views and reject invalid receivers", () => {
    const memory = new ArrayBuffer(10), view = new DataView(memory, 2, 6);
    equal(invoke(view, "hexWrite", "6869"), 2);
    equal(invoke(view, "hexSlice", 0, 2), "6869");
    for (const receiver of [{}, [], null, Symbol("receiver")]) {
      typeError(() => invoke(receiver, "hexSlice", 1));
    }
  });
  add("raw writes preserve fractions and complete UTF-8 and UTF-16 characters", () => {
    const buf = Buffer.alloc(6, 0xcc);
    equal(invoke(buf, "utf8Write", "é", 1.9, 1.9), 0);
    equal(invoke(buf, "utf8Write", "é", 1.9, 2.9), 2);
    equal(invoke(buf, "utf16leWrite", "abc", 3, 3), 2);
    equal(bytes(buf), [0xcc, 0xc3, 0xa9, 97, 0, 0xcc]);
  });
  return checks;
}
