(function () {
  type Context = { not?: boolean; promise?: string };
  type Outcome = { invalid: true } | { invalid?: false; threw: boolean; value: unknown };
  type Failure = { params?: string; body: string; raw?: boolean } | null;

  function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function";
  }

  function settle<T, U>(value: T | PromiseLike<T>, consume: (value: T) => U): U | PromiseLike<U> {
    if (isThenable(value)) {
      return Promise.resolve(value).then(consume);
    }
    return consume(value);
  }

  function throwOutcome(ctx: Context, received: unknown): Outcome | PromiseLike<Outcome> {
    if (ctx.promise) return { threw: ctx.promise === "rejects", value: received };
    if (typeof received !== "function") return { invalid: true };
    try {
      const result: unknown = received();
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
        return Promise.resolve(result).then(
          value => ({ threw: false, value }),
          value => ({ threw: true, value }),
        );
      }
      return { threw: false, value: result };
    } catch (value) {
      return { threw: true, value };
    }
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
    type Record = { observed: boolean; result: Promise<{ error?: unknown }> };
    const records: Record[] = [];
    function track<T>(value: T | PromiseLike<T>): T | PromiseLike<T> {
      if (!isThenable(value)) return value;
      const promise = Promise.resolve(value);
      const record: Record = { observed: false, result: promise.then(() => ({}), error => ({ error })) };
      records.push(record);
      return { then(onfulfilled, onrejected) { record.observed = true; return promise.then(onfulfilled, onrejected); } };
    }
    async function complete<T extends { ok?: boolean }>(result: T, finish: (value: T | { error: unknown }) => void) {
      if (!result.ok) return finish(result);
      for (let i = 0; i < records.length; i++) {
        const record = records[i], settled = await record.result;
        if (!record.observed && "error" in settled) return finish({ error: settled.error });
      }
      finish(result);
    }
    return { track, complete };
  }

  return { settle, throwOutcome, within, pending };
})
