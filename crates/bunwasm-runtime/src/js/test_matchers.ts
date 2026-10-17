(function (internal: { isPromise(value: unknown): boolean; promiseState(value: Promise<unknown>): string }) {
  type Context = { not?: boolean; promise?: string };
  type Outcome = { invalid: true } | { invalid?: false; threw: boolean; value: unknown };
  type Failure = { params?: string; body: string; raw?: boolean } | null;

  const promiseThen = Promise.prototype.then;
  const schedule = setTimeout.bind(globalThis);

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

  return { settle, throwOutcome, within, pending };
})
