// Bun internal modules that generated builtins (node-fetch, undici,
// fast-utf8-stream) require, implemented over bun-wasm's own node:stream and
// error helpers so their classes match what user code sees. Adapted from Bun's
// src/js/internal/webstreams_adapters.ts (ReadableFromWeb),
// src/js/internal/tls.ts (nodeClientTlsToNative), and
// src/js/internal/validators.ts; see
// docs/bun-patches/bun-thirdparty-fetch-builtins.md and
// docs/bun-patches/bun-fast-utf8-stream.md.
(function (internal: BunWasm.Internal) {
  "use strict";
  type ReadableOptions = { objectMode?: boolean; highWaterMark?: number; encoding?: string; signal?: AbortSignal; responseBody?: boolean };
  type NodeReadable = {
    push(chunk: unknown): boolean;
    destroy(error?: unknown): unknown;
  };
  type ReadableClass = new (options: object) => NodeReadable;
  type WebReader = ReadableStreamDefaultReader<unknown>;
  const { Readable } = internal.builtin("node:stream") as { Readable: ReadableClass };
  const then = Promise.prototype.then;

  function settle(promise: Promise<unknown>, callback: (error?: unknown) => void, error: unknown) {
    then.call(promise, () => callback(error), (cancelError: unknown) => callback(error ?? cancelError));
  }

  class ReadableFromWeb extends Readable {
    #reader: WebReader | undefined;
    #closed: boolean;
    #stream: ReadableStream | undefined;
    // node-fetch, undici: `stream` is a Response body, which text(), json(), ... lock for good.
    #responseBody: boolean;

    constructor(options: ReadableOptions, stream: ReadableStream) {
      const { objectMode, highWaterMark, encoding, signal, responseBody = false } = options;
      super({ objectMode, highWaterMark, encoding, signal });
      this.#reader = undefined;
      this.#stream = stream;
      this.#closed = false;
      this.#responseBody = responseBody;
    }

    // Locked before this wrapper opened it: a body method has the contents, nothing to read or cancel.
    #takenByResponse(stream: ReadableStream) {
      return this.#responseBody && stream.locked;
    }

    #handleDone(reader: WebReader) {
      reader.releaseLock();
      this.#reader = undefined;
      this.#closed = true;
      this.push(null);
    }

    #handleError(reader: WebReader | undefined, error: unknown) {
      if (reader) {
        this.#reader = undefined;
        try {
          reader.releaseLock();
        } catch {}
      }
      this.#closed = true;
      this.destroy(error);
    }

    #open(): WebReader | undefined {
      const stream = this.#stream;
      if (!stream) return this.#reader;
      this.#stream = undefined;
      if (this.#takenByResponse(stream)) {
        this.#closed = true;
        this.push(null);
        return undefined;
      }
      return (this.#reader = stream.getReader());
    }

    // One reader.read() per _read(), as in Bun: readMany() would drain a
    // start()-enqueued source before the consumer can abort.
    _read() {
      if (this.#closed) return;
      const reader = this.#open();
      if (!reader) return;
      then.call(
        reader.read(),
        (chunk: ReadableStreamReadResult<unknown>) => {
          if (this.#closed) return;
          if (chunk.done) this.#handleDone(reader);
          else this.push(chunk.value);
        },
        (error: unknown) => this.#handleError(reader, error),
      );
    }

    _destroy(error: unknown, callback: (error?: unknown) => void) {
      if (this.#closed) return callback(error);
      this.#closed = true;
      const reader = this.#reader;
      if (reader) {
        this.#reader = undefined;
        return settle(reader.cancel(error), callback, error);
      }
      const stream = this.#stream;
      this.#stream = undefined;
      if (stream && !this.#takenByResponse(stream)) return settle(stream.cancel(error), callback, error);
      callback(error);
    }
  }

  const nodeClientTlsKeys = [
    "rejectUnauthorized", "ca", "cert", "key", "pfx", "passphrase", "servername", "checkServerIdentity",
    "ciphers", "secureOptions", "minVersion", "maxVersion", "crl", "sigalgs", "ecdhCurve", "allowPartialTrustChain",
  ];

  // `options` of tls.connect() (an https.Agent's options) to the `tls` option of fetch().
  function nodeClientTlsToNative(options: Record<string, unknown>) {
    let tls: Record<string, unknown> | undefined;
    for (const name of nodeClientTlsKeys) {
      let value = options[name];
      if (value == null || value === "") continue;
      if (name === "rejectUnauthorized") value = value !== false;
      else if (name === "allowPartialTrustChain" && value !== true) continue;
      (tls ??= { __proto__: null })[name] = value;
    }
    return tls;
  }

  function aggregateTwoErrors(innerError: Error | undefined, outerError: (Error & { errors?: Error[]; code?: string }) | undefined) {
    if (innerError && outerError && innerError !== outerError) {
      if (Array.isArray(outerError.errors)) {
        outerError.errors.push(innerError);
        return outerError;
      }
      const err: AggregateError & { code?: string } = new AggregateError([outerError, innerError], outerError.message);
      err.code = outerError.code;
      return err;
    }
    return innerError || outerError;
  }

  function inspectArg(value: unknown): string {
    if (typeof value === "string") return `'${value}'`;
    if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return String(value);
    if (typeof value === "bigint") return `${value}n`;
    return internal.describe(value);
  }

  function formatExpected(expected: unknown): string {
    if (!Array.isArray(expected)) return String(expected);
    if (expected.length === 1) return String(expected[0]);
    if (expected.length === 2) return `${expected[0]} or ${expected[1]}`;
    return `one of ${expected.slice(0, -1).join(", ")}, or ${expected[expected.length - 1]}`;
  }

  function makeAbortError(message?: string, options?: ErrorOptions) {
    const err = new Error(message ?? "The operation was aborted", options);
    err.name = "AbortError";
    return Object.assign(err, { code: "ABORT_ERR" });
  }

  function makeBuiltinError(code: string, variant: number, args: readonly unknown[]): Error | undefined {
    if (code === "ERR_INVALID_ARG_TYPE") {
      const [name, expected, actual] = args;
      const kind = String(name).includes(".") ? "property" : "argument";
      return Object.assign(new TypeError(`The "${name}" ${kind} must be ${formatExpected(expected)}. Received ${internal.describe(actual)}`), { code });
    }
    if (code === "ERR_INVALID_ARG_VALUE") {
      const [name, value, reason = "is invalid"] = args;
      const kind = String(name).includes(".") ? "property" : "argument";
      const Ctor = variant === 1 ? RangeError : TypeError;
      return Object.assign(new Ctor(`The ${kind} '${name}' ${reason}. Received ${inspectArg(value)}`), { code });
    }
    if (code === "ERR_OUT_OF_RANGE") {
      const [name, range, received] = args;
      return Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${inspectArg(received)}`), { code });
    }
    if (code === "ERR_INVALID_RETURN_VALUE") {
      const [input, name, value] = args;
      return Object.assign(new TypeError(`Expected ${input} to be returned from the "${name}" function but got ${internal.describe(value)}.`), { code });
    }
    if (code === "ERR_INVALID_STATE") {
      const Ctor = variant === 2 ? RangeError : variant === 1 ? TypeError : Error;
      return Object.assign(new Ctor(`Invalid state: ${String(args[0] ?? "")}`), { code });
    }
    if (code === "ERR_OPERATION_FAILED") return Object.assign(new Error(`Operation failed: ${String(args[0] ?? "")}`), { code });
    if (code === "ERR_STREAM_WRITE_AFTER_END") return Object.assign(new Error("write after end"), { code });
    return undefined;
  }

  type StreamCore = {
    validators: Record<string, unknown>;
    eos: unknown;
    Stream: { destroy?: (stream: unknown, err?: unknown) => void };
  };
  const streamCore = () => internal.require("node_stream_core") as StreamCore;
  const nodeStream = () => internal.builtin("node:stream") as {
    Readable: unknown;
    Writable: unknown;
    addAbortSignal: unknown;
  };
  let cachedValidators: Record<string, unknown> | undefined;
  function streamValidators() {
    return (cachedValidators ??= {
      kValidateObjectNone: 0,
      kValidateObjectAllowNullable: 1,
      kValidateObjectAllowArray: 2,
      kValidateObjectAllowFunction: 4,
      ...streamCore().validators,
    });
  }

  return {
    "internal:webstreams_adapters": { _ReadableFromWeb: ReadableFromWeb },
    "internal:tls": { nodeClientTlsToNative },
    "internal:errors": { aggregateTwoErrors },
    get "internal:validators"() { return streamValidators(); },
    get "internal:streams/readable"() { return nodeStream().Readable; },
    get "internal:streams/writable"() { return nodeStream().Writable; },
    get "internal:streams/end-of-stream"() { return streamCore().eos; },
    get "internal:streams/add-abort-signal"() { return { addAbortSignal: nodeStream().addAbortSignal }; },
    get "internal:streams/destroy"() { return { destroyer: streamCore().Stream.destroy }; },
    makeAbortError,
    makeBuiltinError,
  } as Record<string, unknown>;
})
