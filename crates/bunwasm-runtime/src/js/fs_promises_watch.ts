type FsPromiseWatchEvent = { eventType: string; filename: string | Uint8Array | undefined };
type FsPromiseWatchResult = IteratorResult<FsPromiseWatchEvent, undefined>;
type FsPromiseWatchState = { kind: "open" } | { kind: "closed" } | { kind: "error"; error: unknown };
type FsPromiseWatchWaiter = { resolve(result: FsPromiseWatchResult): void; reject(error: unknown): void };
interface FsPromiseWatchHandle {
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  off(event: "error", listener: (error: unknown) => void): void;
  off(event: "close", listener: () => void): void;
  close(): void;
}
type FsPromiseWatchCallback = (path: string, options: unknown, listener: (eventType: string, filename: FsPromiseWatchEvent["filename"]) => void) => FsPromiseWatchHandle;

(() => (watch: FsPromiseWatchCallback, toPath: (path: unknown) => string) => function watchPromise(path: unknown, options?: unknown) {
  "use strict";
  const filename = toPath(path);
  const value = options !== null && typeof options === "object" && "signal" in options ? options.signal : undefined;
  if (value !== undefined && !(value instanceof AbortSignal)) {
    throw Object.assign(new TypeError('The "options.signal" argument must be an AbortSignal'), { code: "ERR_INVALID_ARG_TYPE" });
  }
  const signal: AbortSignal | undefined = value;
  let state: FsPromiseWatchState = { kind: "open" };
  let watcher: FsPromiseWatchHandle | undefined;
  const events: FsPromiseWatchEvent[] = [];
  const waiters: FsPromiseWatchWaiter[] = [];
  const done: FsPromiseWatchResult = { value: undefined, done: true };
  const abortError = () => Object.assign(new Error("The operation was aborted"), {
    name: "AbortError", code: "ABORT_ERR", cause: signal?.reason,
  });

  function next(): Promise<FsPromiseWatchResult> {
    if (state.kind === "error") {
      const error = state.error;
      state = { kind: "closed" };
      return Promise.reject(error);
    }
    if (state.kind === "closed") return Promise.resolve(done);
    const event = events.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function finish(terminal: Exclude<FsPromiseWatchState, { kind: "open" }>) {
    if (state.kind !== "open") return;
    state = terminal;
    events.length = 0;
    signal?.removeEventListener("abort", onAbort);
    watcher?.off("error", onError);
    watcher?.off("close", onClose);
    watcher?.close();
    for (const waiter of waiters.splice(0)) void next().then(waiter.resolve, waiter.reject);
  }
  function onAbort() { finish({ kind: "error", error: abortError() }); }
  function onError(error: unknown) { finish({ kind: "error", error: signal?.aborted ? abortError() : error }); }
  function onClose() { finish(signal?.aborted ? { kind: "error", error: abortError() } : { kind: "closed" }); }
  function onChange(eventType: string, name: FsPromiseWatchEvent["filename"]) {
    if (state.kind !== "open") return;
    const event = { eventType, filename: name };
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else events.push(event);
  }
  function close() { finish({ kind: "closed" }); state = { kind: "closed" }; return done; }

  if (signal?.aborted) onAbort();
  else {
    watcher = watch(filename, options, onChange);
    watcher.on("error", onError);
    watcher.on("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  return { [Symbol.asyncIterator]() { return { next, return: close }; } };
})
