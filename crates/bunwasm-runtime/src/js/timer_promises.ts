(function (internal: { timers: BunWasm.PromiseTimerApi }) {
  "use strict";
  const t = internal.timers;
  type Options = { signal?: AbortSignal; ref?: boolean };
  type Schedule = (callback: () => void) => BunWasm.PromiseTimerHandle;
  type Clear = (handle: BunWasm.PromiseTimerHandle) => void;
  const abortError = (signal: AbortSignal) => Object.assign(new Error("The operation was aborted"), {
    name: "AbortError", code: "ABORT_ERR", cause: signal.reason,
  });

  function delayed<T>(schedule: Schedule, clear: Clear, value: T, options: Options = {}, cancellable?: (cancel: () => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      let handle: BunWasm.PromiseTimerHandle | undefined;
      let settled = false;
      function cleanup() {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (handle !== undefined) clear(handle);
        return true;
      }
      function finish() { if (cleanup()) resolve(value); }
      function fail(error: unknown) { if (cleanup()) reject(error); }
      function onAbort() { if (signal) fail(abortError(signal)); }
      if (signal?.aborted) { onAbort(); return; }
      cancellable?.(finish);
      try {
        handle = schedule(finish);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        if (!settled && options.ref === false) handle.unref?.();
      } catch (error) { fail(error); }
    });
  }

  const setTimeoutP = <T>(ms?: number, value?: T, options?: Options) => delayed(cb => t.setTimeout(cb, ms), t.clearTimeout, value, options);
  const setImmediateP = <T>(value?: T, options?: Options) => delayed(cb => t.setImmediate(cb), t.clearImmediate, value, options);

  function setIntervalP<T>(ms?: number, value?: T, options?: Options) {
    let closed = false;
    let cancel: (() => void) | undefined;
    function close() {
      closed = true;
      cancel?.();
      cancel = undefined;
    }
    function rememberCancel(callback: () => void) { cancel = callback; }
    async function* ticks(): AsyncGenerator<T | undefined, unknown, unknown> {
      try {
        while (!closed) {
          await delayed(cb => t.setTimeout(cb, ms), t.clearTimeout, undefined, options, rememberCancel);
          cancel = undefined;
          if (closed) return;
          if (options?.signal?.aborted) throw abortError(options.signal);
          yield value;
        }
      } finally { close(); }
    }
    const iterator = ticks();
    const next = iterator.next.bind(iterator);
    const finish = iterator.return.bind(iterator);
    const fail = iterator.throw.bind(iterator);
    type Result = IteratorResult<T | undefined, unknown>;
    let pending: Promise<Result> | undefined;
    // QuickJS can strand requests queued behind a completed generator.
    function enqueue(action: () => Promise<Result>) {
      const result = pending ? pending.then(action, action) : action();
      pending = result;
      const release = () => { if (pending === result) pending = undefined; };
      void result.then(release, release);
      return result.then(value => value);
    }
    iterator.next = (...args) => enqueue(() => next(...args));
    iterator.return = value => { close(); return enqueue(() => finish(value)); };
    iterator.throw = error => { close(); return enqueue(() => fail(error)); };
    return iterator;
  }

  return {
    setTimeout: setTimeoutP,
    setImmediate: setImmediateP,
    setInterval: setIntervalP,
    scheduler: { wait: (ms?: number, options?: Options) => setTimeoutP(ms, undefined, options), yield: () => setImmediateP() },
  };
})
