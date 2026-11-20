// Bun internal modules that the generated thirdparty builtins (node-fetch,
// undici) require, implemented over bun-wasm's own node:stream so their
// streams are the same classes user code sees. Adapted from Bun's
// src/js/internal/webstreams_adapters.ts (ReadableFromWeb) and
// src/js/internal/tls.ts (nodeClientTlsToNative); see
// docs/bun-patches/bun-thirdparty-fetch-builtins.md.
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

  return {
    "internal:webstreams_adapters": { _ReadableFromWeb: ReadableFromWeb },
    "internal:tls": { nodeClientTlsToNative },
  } as Record<string, unknown>;
})
