(function (internal: {
  BunFile?: { readonly prototype: object };
  realTimers: { setTimeout(callback: () => void, delay: number): unknown };
  isPromise(value: unknown): boolean;
  promiseState(value: Promise<unknown>): string;
  promiseThen<T, U>(value: Promise<T>, fulfilled: (value: T) => U | Promise<U>, rejected?: (error: unknown) => U | Promise<U>): Promise<U>;
}) {
  type Context = { not?: boolean; promise?: string };
  type Outcome = { invalid: true } | { invalid?: false; threw: boolean; value: unknown };
  type Failure = { params?: string; body: string; raw?: boolean } | null;

  const promiseThen = internal.promiseThen;
  const schedule = internal.realTimers.setTimeout;
  const stringValueOf = String.prototype.valueOf;
  const apply = Reflect.apply;
  const noArgs: readonly unknown[] = [];
  const isPrototypeOf = Object.prototype.isPrototypeOf;
  const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
  const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get;
  const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
  const blobBytes = Object.getOwnPropertyDescriptor(Blob.prototype, "_bytes")?.value;
  const bunFilePrototype = internal.BunFile?.prototype;
  const bunFileSize = bunFilePrototype && Object.getOwnPropertyDescriptor(bunFilePrototype, "size")?.get;

  function isStringValue(value: unknown): boolean {
    if (typeof value === "string") return true;
    if (value === null || typeof value !== "object") return false;
    try {
      apply(stringValueOf, value, noArgs);
      return true;
    } catch {
      return false;
    }
  }

  function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
    return internal.isPromise(value);
  }

  function react<T, U>(value: Promise<T>, fulfilled: (value: T) => U | Promise<U>, rejected?: (error: unknown) => U | Promise<U>): Promise<U> {
    return promiseThen(value, fulfilled, rejected);
  }

  function settle<T, U>(value: T | Promise<T>, consume: (value: T) => U | Promise<U>): U | Promise<U> {
    if (isPromise(value)) return react(value, consume);
    return consume(value);
  }

  function every<T>(values: readonly T[], compare: (value: T, index: number) => boolean | Promise<boolean>, index = 0): boolean | Promise<boolean> {
    for (let i = index; i < values.length; i++) {
      if (!(i in values)) continue;
      const result = compare(values[i], i);
      if (isPromise(result)) return settle(result, pass => pass && every(values, compare, i + 1));
      if (!result) return false;
    }
    return true;
  }

  function some<T>(values: readonly T[], compare: (value: T, index: number) => boolean | Promise<boolean>, index = 0): boolean | Promise<boolean> {
    for (let i = index; i < values.length; i++) {
      if (!(i in values)) continue;
      const result = compare(values[i], i);
      if (isPromise(result)) return settle(result, pass => pass || some(values, compare, i + 1));
      if (result) return true;
    }
    return false;
  }

  function ancestors<T>(seen: Set<T>, value: T, compare: () => boolean | Promise<boolean>): boolean | Promise<boolean> {
    if (seen.has(value)) return true;
    seen.add(value);
    try {
      const result = compare();
      if (!isPromise(result)) {
        seen.delete(value);
        return result;
      }
      return react(result, pass => { seen.delete(value); return pass; }, error => { seen.delete(value); throw error; });
    } catch (error) {
      seen.delete(value);
      throw error;
    }
  }

  function throwOutcome(ctx: Context, received: unknown): Outcome | Promise<Outcome> {
    if (typeof received !== "function") return ctx.promise ? { threw: true, value: received } : { invalid: true };
    let result: unknown;
    try {
      result = received();
    } catch (value) {
      return { threw: true, value };
    }
    if (!isPromise(result)) return { threw: false, value: result };
    return react<unknown, Outcome>(result,
      value => ({ threw: false, value }),
      value => ({ threw: true, value }),
    );
  }

  function within(ctx: Context, received: unknown, ...bounds: unknown[]): Failure {
    if (bounds.length < 2) throw new TypeError("toBeWithin() requires 2 arguments");
    const [start, end] = bounds;
    if (typeof start !== "number") throw new Error("toBeWithin() requires the first argument to be a number");
    if (typeof end !== "number") throw new Error("toBeWithin() requires the second argument to be a number");
    const pass = typeof received === "number" && received >= start && received < end;
    if (pass !== !!ctx.not) return null;
    return { body: `\n\nExpected: ${ctx.not ? "not " : ""}between ${start} (inclusive) and ${end} (exclusive)\nReceived: ${String(received)}\n` };
  }

  function even(value: unknown): boolean {
    if (typeof value === "bigint") return value % 2n === 0n;
    return typeof value === "number" && Number.isInteger(value) && value % 2 === 0;
  }

  function odd(value: unknown): boolean {
    if (typeof value === "bigint") return value % 2n !== 0n;
    return typeof value === "number" && Number.isInteger(value) && Math.abs(value % 2) === 1;
  }

  function isIterable(value: object): value is Iterable<unknown> {
    return typeof Reflect.get(value, Symbol.iterator) === "function";
  }

  function empty(value: unknown): boolean {
    if (typeof value === "string" || value instanceof String || Array.isArray(value)) return value.length === 0;
    if (value instanceof Map || value instanceof Set) return value.size === 0;
    if (value instanceof Blob && blobSize) {
      if (bunFilePrototype && bunFileSize && apply(isPrototypeOf, bunFilePrototype, [value])) return apply(bunFileSize, value, noArgs) === 0;
      if (typeof blobBytes === "function" && typedArrayByteLength) return apply(typedArrayByteLength, apply(blobBytes, value, noArgs), noArgs) === 0;
      return apply(blobSize, value, noArgs) === 0;
    }
    if (value instanceof ArrayBuffer && arrayBufferByteLength) {
      try { return apply(arrayBufferByteLength, value, noArgs) === 0; } catch {}
    }
    if (ArrayBuffer.isView(value) && typedArrayByteLength) {
      try { return apply(typedArrayByteLength, value, noArgs) === 0; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
    }
    if (typeof value === "function") return Object.keys(value).length === 0;
    if (value === null || typeof value !== "object") return false;
    if (!isIterable(value)) return Object.keys(value).length === 0;
    let empty = true;
    for (const _item of value) empty = false;
    return empty;
  }

  function constant(ctx: Context, name: "pass" | "fail", pass: boolean, args: unknown[]): Failure {
    if (args.length > 0 && !isStringValue(args[0])) throw new TypeError(`Expected message to be a string for '${name}'.`);
    const message = args.length === 0 ? `${pass ? "passes" : "fails"} by .${name}() assertion` : String(args[0]);
    if (pass !== !!ctx.not) return null;
    return { body: `\n\n${message}\n` };
  }

  function arrayOfSize(inspect: (value: unknown) => string, ctx: Context, received: unknown, ...args: unknown[]): Failure {
    if (args.length === 0) throw new TypeError("toBeArrayOfSize() requires 1 argument");
    const size = args[0];
    if (typeof size !== "number" || !Number.isInteger(size) || Object.is(size, -0) || size < -(2 ** 51) || size >= 2 ** 51) {
      throw new Error("toBeArrayOfSize() requires the first argument to be a number");
    }
    if ((Array.isArray(received) && received.length === size) !== !!ctx.not) return null;
    return { body: `\n\nReceived: ${inspect(received)}\n` };
  }

  function ignoringWhitespace(inspect: (value: unknown) => string, ctx: Context, received: unknown, ...args: unknown[]): Failure {
    if (args.length === 0) throw new TypeError("toEqualIgnoringWhitespace() requires 1 argument");
    const expected = args[0];
    if (!isStringValue(expected)) {
      throw new Error("toEqualIgnoringWhitespace() requires argument to be a string");
    }
    const pass = isStringValue(received)
      && String(received).replace(/[ \t-\r]/g, "") === String(expected).replace(/[ \t-\r]/g, "");
    if (pass !== !!ctx.not) return null;
    return { body: `\n\nExpected: ${ctx.not ? "not " : ""}${inspect(expected)}\nReceived: ${inspect(received)}\n` };
  }

  function extended(inspect: (value: unknown) => string) {
    return {
      pass: (ctx: Context, _received: unknown, ...args: unknown[]) => constant(ctx, "pass", true, args),
      fail: (ctx: Context, _received: unknown, ...args: unknown[]) => constant(ctx, "fail", false, args),
      arrayOfSize: arrayOfSize.bind(undefined, inspect),
      ignoringWhitespace: ignoringWhitespace.bind(undefined, inspect),
    };
  }

  function nthReturned(options: {
    not?: boolean;
    results: readonly unknown[];
    nth: unknown;
    expected: unknown;
    equals(received: unknown, expected: unknown, strict: boolean): boolean | Promise<boolean>;
    inspect(value: unknown): string;
    formatDiff(received: string, expected: string, strict: boolean): string;
  }): Failure | Promise<Failure> {
    const { not, results, nth, expected, equals, inspect, formatDiff } = options;
    if (typeof nth !== "number" || !Number.isInteger(nth) || Object.is(nth, -0) || nth < -(2 ** 51) || nth >= 2 ** 51) {
      throw new TypeError("toHaveNthReturnedWith() first argument must be an integer");
    }
    if (nth <= 0) throw new TypeError("toHaveNthReturnedWith() n must be greater than 0");
    const call = Math.min(nth, 2 ** 31 - 1);
    const result = results[call - 1];
    const record = result !== null && typeof result === "object" ? result : undefined;
    const type = record && "type" in record ? record.type : undefined;
    const value = record && "value" in record ? record.value : undefined;
    const pass = type === "return" && equals(value, expected, false);
    return settle(pass, matched => nthReturnFailure(matched, !!not, call, results.length, type, value, expected, inspect, formatDiff));
  }

  function nthReturnFailure(pass: boolean, not: boolean, call: number, count: number, type: unknown, value: unknown, expected: unknown,
    inspect: (value: unknown) => string, formatDiff: (received: string, expected: string, strict: boolean) => string): Failure {
    if (pass !== !!not) return null;
    if (not) return { body: `\n\nExpected mock function not to have returned on call ${call}: ${inspect(expected)}\nBut it did.\n` };
    if (call > count) {
      return { body: `\n\nThe mock function was called ${count} time${count === 1 ? "" : "s"}, but call ${call} was requested.\n` };
    }
    if (type === "throw") return { body: `\n\nCall ${call} threw an error: ${inspect(value)}\n` };
    if (typeof value === "string" && typeof expected === "string") {
      return { body: `\n\nCall ${call}:\n${formatDiff(value, expected, false)}\n` };
    }
    return { body: `\n\nCall ${call}:\nExpected: ${inspect(expected)}\nReceived: ${inspect(value)}` };
  }

  function pending() {
    type Rejection = { kind: "none" } | { kind: "unhandled"; error: unknown };
    const records = new Map<Promise<unknown>, Rejection>();
    let closed = false;
    function track<T>(value: T): T {
      if (!closed && isPromise<unknown>(value) && !records.has(value)) records.set(value, { kind: "none" });
      return value;
    }
    function unhandled(error: unknown, promise: unknown): boolean {
      if (closed || !isPromise<unknown>(promise) || !records.has(promise)) return false;
      records.set(promise, { kind: "unhandled", error });
      return true;
    }
    function close(consume: boolean) {
      closed = true;
      if (consume) consumeRemaining();
      records.clear();
    }
    function consumeRemaining() {
      for (const [promise, rejection] of records) {
        if (rejection.kind === "unhandled") continue;
        react(promise, () => undefined, () => undefined);
      }
    }
    function tick(): Promise<void> {
      return new Promise(resolve => schedule(resolve, 0));
    }
    async function complete<T extends { ok?: boolean }>(result: T, finish: (value: T | { error: unknown }) => void) {
      if (closed) return;
      if (!result.ok || records.size === 0) {
        close(!result.ok);
        return finish(result);
      }
      do {
        await tick();
        if (closed) return;
      } while (Array.from(records.keys()).some(promise => internal.promiseState(promise) === "pending"));
      // Rejection notifications belong to the engine's checkpoint after settlement.
      await tick();
      if (closed) return;
      const rejection = Array.from(records.values()).find(value => value.kind === "unhandled");
      close(false);
      finish(rejection?.kind === "unhandled" ? { error: rejection.error } : result);
    }
    return { track, unhandled, complete };
  }

  return { settle, every, some, ancestors, throwOutcome, within, nthReturned, pending, even, odd, empty, extended };
})
