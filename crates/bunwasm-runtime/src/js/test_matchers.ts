(function (internal: { isPromise(value: unknown): boolean }) {
  type Context = { not?: boolean; promise?: string };
  type Outcome = { invalid: true } | { invalid?: false; threw: boolean; value: unknown };
  type Failure = { params?: string; body: string; raw?: boolean } | null;

  const promiseThen = Promise.prototype.then;

  function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
    return internal.isPromise(value);
  }

  function react<T, U>(value: Promise<T>, fulfilled: (value: T) => U, rejected?: (error: unknown) => U): Promise<U> {
    return Reflect.apply(promiseThen, value, [fulfilled, rejected]);
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

  function pending() {
    type Settlement = { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
    type Record = { observed: boolean; result: Promise<Settlement>; restore(): void };
    const records = new Map<Promise<unknown>, Record>();
    function track<T>(value: T): T {
      if (!isPromise<unknown>(value) || records.has(value)) return value;
      const descriptor = Object.getOwnPropertyDescriptor(value, "constructor");
      const prototype: object = Object.getPrototypeOf(value);
      function restore() {
        if (Object.getOwnPropertyDescriptor(value, "constructor")?.get !== observedConstructor) return;
        return descriptor ? Reflect.defineProperty(value, "constructor", descriptor) : Reflect.deleteProperty(value, "constructor");
      }
      const record: Record = { observed: false, restore, result: react<unknown, Settlement>(value,
        () => ({ kind: "fulfilled" }), error => ({ kind: "rejected", error }),
      ) };
      // Await reads constructor before retaining a native promise's fulfillment without re-assimilation.
      function observedConstructor() {
        record.observed = true;
        restore();
        if (!descriptor) return Reflect.get(prototype, "constructor", value);
        return "value" in descriptor ? descriptor.value : descriptor.get?.call(value);
      }
      Object.defineProperty(value, "constructor", { configurable: true, get: observedConstructor });
      records.set(value, record);
      return value;
    }
    function finishPending<T>(result: T, finish: (value: T) => void) {
      for (const record of records.values()) record.restore();
      finish(result);
    }
    async function complete<T extends { ok?: boolean }>(result: T, finish: (value: T | { error: unknown }) => void) {
      if (!result.ok) return finishPending(result, finish);
      for (const record of records.values()) {
        const settled = await record.result;
        record.restore();
        if (!record.observed && settled.kind === "rejected") return finishPending({ error: settled.error }, finish);
      }
      finishPending(result, finish);
    }
    return { track, complete };
  }

  return { settle, throwOutcome, within, pending };
})
