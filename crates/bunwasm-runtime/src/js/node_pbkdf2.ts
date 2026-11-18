// node:crypto pbkdf2 and pbkdf2Sync with the argument checks of Node's
// lib/internal/crypto/pbkdf2.js and native Bun 1.4.4's messages. The digest is any
// Bun.CryptoHasher algorithm that supports HMAC (node_digest.ts), and the
// derivation runs in node_digest.rs.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Digests = { hasherName(name: string): string | undefined; hasherHmac(name: string): boolean };
  type Bytes = Uint8Array;
  type Callback = (error: Error | null, key?: Bytes) => void;

  function argType(name: string, expected: string, value: unknown): TypeError {
    return Object.assign(new TypeError(`The "${name}" argument must be of type ${expected}. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function int32(value: unknown, name: string, min: number): number {
    if (typeof value !== "number") throw argType(name, "number", value);
    const rule = !Number.isInteger(value) ? "an integer" : value < min || value > 2147483647 ? `>= ${min} and <= 2147483647` : null;
    if (rule) throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${rule}. Received ${String(value)}`), { code: "ERR_OUT_OF_RANGE" });
    return value;
  }

  return function create(digests: Digests, Buffer: BunWasm.BufferConstructor) {
    function bytes(value: unknown, name: string): Bytes {
      if (typeof value === "string" || value instanceof String) return internal.native.utf8Encode(String(value));
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return internal.toUint8(value).slice();
      throw argType(name, "string or buffer", value);
    }

    // Node's check(): digest, then password and salt, then iterations and keylen.
    function check(password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown) {
      if (typeof digest !== "string") throw argType("digest", "string", digest);
      const passwordBytes = bytes(password, "password");
      const saltBytes = bytes(salt, "salt");
      const rounds = int32(iterations, "iterations", 1);
      const length = int32(keylen, "keylen", 0);
      const name = digests.hasherName(digest);
      if (name === undefined || !digests.hasherHmac(name)) throw Object.assign(new TypeError(`Invalid digest: ${digest}`), { code: "ERR_CRYPTO_INVALID_DIGEST" });
      return () => derive(name, passwordBytes, saltBytes, rounds, length);
    }

    function derive(name: string, password: Bytes, salt: Bytes, iterations: number, keylen: number): Bytes {
      if (keylen === 0) throw new Error("PBKDF2 derivation failed");
      const key = internal.native.nodePbkdf2(name, password, salt, iterations, keylen);
      return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
    }

    function pbkdf2Sync(password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown): Bytes {
      return check(password, salt, iterations, keylen, digest)();
    }

    function pbkdf2(password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown, callback: unknown): void {
      if (typeof digest === "function") {
        callback = digest;
        digest = undefined;
      }
      const run = check(password, salt, iterations, keylen, digest);
      if (typeof callback !== "function") throw argType("callback", "function", callback);
      const done = callback as Callback;
      const context = internal.native.getAsyncContext();
      internal.realTimers.setImmediate(() => {
        let key: Bytes;
        try {
          key = run();
        } catch (error) {
          internal.runInContext(context, done, undefined, [error as Error]);
          return;
        }
        internal.runInContext(context, done, undefined, [null, key]);
      });
    }

    return { pbkdf2Sync, pbkdf2 };
  };
})
