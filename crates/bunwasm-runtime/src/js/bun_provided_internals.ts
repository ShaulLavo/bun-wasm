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

  function invalidArgType(name: string, expected: string | readonly string[], value: unknown) {
    const want = Array.isArray(expected) ? expected.join(" or ") : expected;
    return Object.assign(new TypeError(`The "${name}" argument must be of type ${want}. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function invalidArgValue(name: string, value: unknown, reason = "is invalid", range = false) {
    const Ctor = range ? RangeError : TypeError;
    return Object.assign(new Ctor(`The argument '${name}' ${reason}. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_VALUE" });
  }

  function outOfRange(name: string, expected: string, value: unknown) {
    return Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${expected}. Received ${String(value)}`), { code: "ERR_OUT_OF_RANGE" });
  }

  function makeBuiltinError(code: string, variant: number, args: readonly unknown[]) {
    if (code === "ERR_INVALID_ARG_TYPE") return invalidArgType(String(args[0]), args[1] as string | readonly string[], args[2]);
    if (code === "ERR_INVALID_ARG_VALUE") return invalidArgValue(String(args[0]), args[1], args[2] === undefined ? undefined : String(args[2]), variant === 1);
    if (code === "ERR_INVALID_STATE") {
      const Ctor = variant === 1 ? TypeError : variant === 2 ? RangeError : Error;
      return Object.assign(new Ctor(`Invalid state: ${String(args[0] ?? "")}`), { code });
    }
    if (code === "ERR_OPERATION_FAILED") return Object.assign(new Error(`Operation failed: ${String(args[0] ?? "")}`), { code });
    return undefined;
  }

  function validateBoolean(value: unknown, name: string) {
    if (typeof value !== "boolean") throw invalidArgType(name, "boolean", value);
  }

  function validateFunction(value: unknown, name: string) {
    if (typeof value !== "function") throw invalidArgType(name, "function", value);
  }

  function validateString(value: unknown, name: string) {
    if (typeof value !== "string") throw invalidArgType(name, "string", value);
  }

  function validateObject(value: unknown, name: string, options: number | { nullable?: boolean; allowArray?: boolean; allowFunction?: boolean } = 0) {
    const nullable = typeof options === "number" ? (options & 1) !== 0 : Boolean(options?.nullable);
    const allowArray = typeof options === "number" ? (options & 2) !== 0 : Boolean(options?.allowArray);
    const allowFunction = typeof options === "number" ? (options & 4) !== 0 : Boolean(options?.allowFunction);
    if ((!nullable && value === null) || (!allowArray && Array.isArray(value)) || (typeof value !== "object" && (!allowFunction || typeof value !== "function"))) {
      throw invalidArgType(name, "Object", value);
    }
  }

  function validateOneOf(value: unknown, name: string, oneOf: readonly unknown[]) {
    if (!oneOf.includes(value)) {
      const list = oneOf.map((item) => (typeof item === "string" ? `'${item}'` : String(item))).join(", ");
      throw invalidArgValue(name, value, `must be one of: ${list}`);
    }
  }

  function validateUint32(value: unknown, name: string, positive = false) {
    if (typeof value !== "number") throw invalidArgType(name, "number", value);
    if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
    const min = positive ? 1 : 0;
    if (value < min || value > 4294967295) throw outOfRange(name, `>= ${min} && <= 4294967295`, value);
  }

  return {
    "internal:webstreams_adapters": { _ReadableFromWeb: ReadableFromWeb },
    "internal:tls": { nodeClientTlsToNative },
    "internal:validators": {
      kValidateObjectNone: 0,
      kValidateObjectAllowNullable: 1,
      kValidateObjectAllowArray: 2,
      kValidateObjectAllowFunction: 4,
      validateBoolean,
      validateFunction,
      validateObject,
      validateOneOf,
      validateString,
      validateUint32,
    },
    makeBuiltinError,
  } as Record<string, unknown>;
})
