// AbortSignal support for readFile, writeFile and appendFile, and fs.promises.writeFile of
// an iterable, after Bun's src/js/node/fs.promises.ts (writeFileAsyncIterator). Aborts
// reject with Node's AbortError: an Error named "AbortError" whose code is "ABORT_ERR",
// whose message is "The operation was aborted" and whose cause is signal.reason. The
// whole-file operations here finish in one synchronous step, so an abort that arrives
// while one is in flight replaces its result when it is delivered.
(function () {
  "use strict";
  type Options = { encoding?: unknown; flag?: unknown; mode?: unknown; signal?: unknown } | null | undefined;
  type Deps = {
    openSync(path: unknown, flags: unknown, mode: unknown): number;
    closeSync(fd: number): void;
    writeSync(fd: number, data: unknown): number;
    ftruncateSync(fd: number, length: number): void;
    isEncoding(encoding: unknown): boolean;
    encode(chunk: string, encoding: string): Uint8Array;
    describe(value: unknown): string;
    later(fn: () => void): void;
  };
  type Callback = (error: unknown, ...values: unknown[]) => void;

  return function createAbortable(deps: Deps) {
    function abortError(signal: AbortSignal): Error {
      const error = new Error("The operation was aborted", { cause: signal.reason });
      return Object.assign(error, { name: "AbortError", code: "ABORT_ERR" });
    }

    function signalOf(options: unknown): AbortSignal | undefined {
      if (options === null || typeof options !== "object") return undefined;
      const signal = (options as { signal?: unknown }).signal;
      if (signal === undefined) return undefined;
      if (signal === null || typeof signal !== "object" || !("aborted" in signal)) {
        throw Object.assign(new TypeError(`The "options.signal" property must be an instance of AbortSignal. Received ${deps.describe(signal)}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
      return signal as AbortSignal;
    }

    // A promise-returning operation under a signal: rejected up front when the signal is
    // already aborted, and with an AbortError when it aborts before the result arrives.
    function promise<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
      if (signal.aborted) return Promise.reject(abortError(signal));
      const settle = (fail: boolean, value: unknown) => {
        if (signal.aborted) throw abortError(signal);
        if (fail) throw value;
        return value as T;
      };
      return start().then((value) => settle(false, value), (error) => settle(true, error));
    }

    // The callback flavour of the same rule; a pre-aborted call still calls back later.
    function callback(signal: AbortSignal, start: (done: Callback) => void, done: Callback) {
      if (signal.aborted) {
        const error = abortError(signal);
        deps.later(() => done(error));
        return;
      }
      start((error, ...values) => {
        if (signal.aborted) done(abortError(signal));
        else done(error, ...values);
      });
    }

    function isIterableData(data: unknown): boolean {
      if (typeof data === "string" || ArrayBuffer.isView(data) || data === null || typeof data !== "object") return false;
      const value = data as { [Symbol.iterator]?: unknown; [Symbol.asyncIterator]?: unknown };
      return typeof value[Symbol.iterator] === "function" || typeof value[Symbol.asyncIterator] === "function";
    }

    // The only flag spellings whose open truncates. `r+` and the like overwrite in place,
    // so the file must not be cut down to the bytes written.
    function flagTruncates(flag: unknown): boolean {
      return flag === "w" || flag === "w+" || flag === "wx" || flag === "wx+" || flag === "xw" || flag === "xw+";
    }

    function iterableOptions(options: unknown): { encoding: unknown; flag: unknown; mode: unknown; signal: AbortSignal | undefined } {
      if (options !== null && typeof options === "object") {
        const given = options as NonNullable<Options>;
        const signal = signalOf(given);
        if (signal?.aborted) throw abortError(signal);
        return { encoding: given.encoding ?? "utf8", flag: given.flag ?? "w", mode: given.mode ?? 0o666, signal };
      }
      return { encoding: options || "utf8", flag: "w", mode: 0o666, signal: undefined };
    }

    function chunkBytes(chunk: unknown, encoding: string): unknown {
      const reencode = !(encoding === "utf8" || encoding === "utf-8" || encoding === "binary" || encoding === "buffer");
      if (reencode && typeof chunk === "string") return deps.encode(chunk, encoding);
      if (chunk === undefined || chunk === null) {
        throw Object.assign(new TypeError(`The "chunk" argument must be of type string or an instance of ArrayBufferView or ArrayBuffer. Received ${deps.describe(chunk)}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
      return chunk;
    }

    async function writeChunks(fd: number, iterable: AsyncIterable<unknown> | Iterable<unknown>, encoding: string, signal: AbortSignal | undefined) {
      let written = 0;
      for await (const chunk of iterable) {
        if (signal?.aborted) throw abortError(signal);
        written += deps.writeSync(fd, chunkBytes(chunk, encoding));
      }
      return written;
    }

    // fs.promises.writeFile of a sync or async iterable: open (unless given a descriptor),
    // write each chunk at the current offset, then cut a truncating write to its length.
    async function writeIterable(target: unknown, iterable: AsyncIterable<unknown> | Iterable<unknown>, options: unknown) {
      const { encoding, flag, mode, signal } = iterableOptions(options);
      if (!deps.isEncoding(encoding)) throw new TypeError(`Unknown encoding: ${String(encoding)}`);
      const owned = typeof target !== "number";
      const fd = owned ? deps.openSync(target, flag, mode) : target;
      if (signal?.aborted) {
        if (owned) deps.closeSync(fd);
        throw abortError(signal);
      }
      let written = 0;
      let failure: { error: unknown } | undefined;
      try {
        written = await writeChunks(fd, iterable, encoding as string, signal);
      } catch (error) {
        failure = { error };
      }
      if (owned) closeIterableTarget(fd, flag, written);
      // An abort replaces any other error.
      if (signal?.aborted) throw abortError(signal);
      if (failure) throw failure.error;
    }

    function closeIterableTarget(fd: number, flag: unknown, written: number) {
      if (flagTruncates(flag)) {
        try { deps.ftruncateSync(fd, written); } catch { /* Bun ignores a failed truncate here. */ }
      }
      deps.closeSync(fd);
    }

    return { abortError, signalOf, promise, callback, isIterableData, writeIterable };
  };
})
