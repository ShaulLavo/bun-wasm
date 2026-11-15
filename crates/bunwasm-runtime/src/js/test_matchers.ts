(function (internal: {
  isPromise(value: unknown): boolean;
  promiseState(value: Promise<unknown>): string;
  promiseThen<T, U>(value: Promise<T>, fulfilled: (value: T) => U, rejected?: (error: unknown) => U): Promise<U>;
}) {
  type Context = { not?: boolean; promise?: string };
  type Outcome = { invalid: true } | { invalid?: false; threw: boolean; value: unknown };
  type Failure = { params?: string; body: string; raw?: boolean } | null;

  const promiseThen = internal.promiseThen;
  const schedule = setTimeout.bind(globalThis);

  function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
    return internal.isPromise(value);
  }

  function react<T, U>(value: Promise<T>, fulfilled: (value: T) => U, rejected?: (error: unknown) => U): Promise<U> {
    return promiseThen(value, fulfilled, rejected);
  }

  function settle<T, U>(value: T | Promise<T>, consume: (value: T) => U): U | Promise<U> {
    if (isPromise(value)) return react(value, consume);
    return consume(value);
  }

  function throwOutcome(ctx: Context, received: unknown): Outcome | Promise<Outcome> {
    if (ctx.promise) return { threw: ctx.promise === "rejects", value: received };
    if (typeof received !== "function") return { invalid: true };
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

  function empty(value: unknown): boolean {
    if (typeof value === "string" || value instanceof String || Array.isArray(value)) return value.length === 0;
    if (value instanceof Map || value instanceof Set || value instanceof Blob) return value.size === 0;
    if (value instanceof ArrayBuffer) return value.byteLength === 0;
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value.byteLength === 0;
    if (value === null || typeof value !== "object" && typeof value !== "function") return false;
    const iterate: unknown = Reflect.get(value, Symbol.iterator);
    if (typeof iterate !== "function") return Object.keys(value).length === 0;
    const iterable: Iterable<unknown> = { [Symbol.iterator]: () => Reflect.apply(iterate, value, []) };
    let empty = true;
    for (const _item of iterable) empty = false;
    return empty;
  }

  function constant(ctx: Context, name: "pass" | "fail", pass: boolean, args: unknown[]): Failure {
    if (args.length > 0 && typeof args[0] !== "string") throw new TypeError(`Expected message to be a string for '${name}'.`);
    if (pass !== !!ctx.not) return null;
    const message = args.length === 0 ? `${pass ? "passes" : "fails"} by .${name}() assertion` : args[0];
    return { body: `\n\n${message}\n` };
  }

  function extended(inspect: (value: unknown) => string) {
    function arrayOfSize(ctx: Context, received: unknown, ...args: unknown[]): Failure {
      if (args.length === 0) throw new TypeError("toBeArrayOfSize() requires 1 argument");
      const size = args[0];
      if (typeof size !== "number" || !Number.isInteger(size) || Object.is(size, -0)) {
        throw new Error("toBeArrayOfSize() requires the first argument to be a number");
      }
      if ((Array.isArray(received) && received.length === size) !== !!ctx.not) return null;
      return { body: `\n\nReceived: ${inspect(received)}\n` };
    }

    function ignoringWhitespace(ctx: Context, received: unknown, ...args: unknown[]): Failure {
      if (args.length === 0) throw new TypeError("toEqualIgnoringWhitespace() requires 1 argument");
      const expected = args[0];
      if (typeof expected !== "string" && !(expected instanceof String)) {
        throw new Error("toEqualIgnoringWhitespace() requires argument to be a string");
      }
      const pass = (typeof received === "string" || received instanceof String)
        && String(received).replace(/[ \t-\r]/g, "") === String(expected).replace(/[ \t-\r]/g, "");
      if (pass !== !!ctx.not) return null;
      return { body: `\n\nExpected: ${ctx.not ? "not " : ""}${inspect(expected)}\nReceived: ${inspect(received)}\n` };
    }

    return {
      pass: (ctx: Context, _received: unknown, ...args: unknown[]) => constant(ctx, "pass", true, args),
      fail: (ctx: Context, _received: unknown, ...args: unknown[]) => constant(ctx, "fail", false, args),
      arrayOfSize,
      ignoringWhitespace,
    };
  }

  function nthReturned(options: {
    not?: boolean;
    results: readonly unknown[];
    nth: unknown;
    expected: unknown;
    equals(received: unknown, expected: unknown, strict: boolean): boolean;
    inspect(value: unknown): string;
    formatDiff(received: string, expected: string, strict: boolean): string;
  }): Failure {
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
    if (pass !== !!not) return null;
    if (not) return { body: `\n\nExpected mock function not to have returned on call ${call}: ${inspect(expected)}\nBut it did.\n` };
    if (call > results.length) {
      return { body: `\n\nThe mock function was called ${results.length} time${results.length === 1 ? "" : "s"}, but call ${call} was requested.\n` };
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

  return { settle, throwOutcome, within, nthReturned, pending, even, odd, empty, extended };
})
