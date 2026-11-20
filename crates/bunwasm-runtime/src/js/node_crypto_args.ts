// Argument checks and conversions shared by node:crypto's ciphers, Diffie-Hellman, ECDH and
// primes (node_cipher.ts, node_dh.ts), with the messages of Node's validators and Bun's
// CryptoUtil.cpp and ErrorCode.ts.
(function (internal: BunWasm.Internal) {
  "use strict";
  const { Buffer } = internal.require("buffer") as { Buffer: NodeCrypto.Args["Buffer"] };
  let inspect: ((value: unknown) => string) | undefined;
  const shown = (value: unknown) => (inspect ??= internal.require("inspect").nodeInspect)(value);

  function coded<E extends Error>(error: E, code: string): E & { code: string } {
    return Object.assign(error, { code });
  }

  const kind = (name: string) => (name.includes(".") ? "property" : "argument");

  function argType(name: string, expected: string, value: unknown): TypeError {
    const what = expected.startsWith("an instance") ? expected : `of type ${expected}`;
    return coded(new TypeError(`The "${name}" ${kind(name)} must be ${what}. Received ${internal.describe(value)}`), "ERR_INVALID_ARG_TYPE");
  }

  function invalidArgValue(name: string, value: unknown, reason = "is invalid"): TypeError {
    let text = shown(value);
    if (text.length > 128) text = `${text.slice(0, 128)}...`;
    return coded(new TypeError(`The ${kind(name)} '${name}' ${reason}. Received ${text}`), "ERR_INVALID_ARG_VALUE");
  }

  // Node's ERR_OUT_OF_RANGE: integers past 2^32 print with numeric separators.
  function received(value: number): string {
    if (!Number.isInteger(value) || Math.abs(value) <= 2 ** 32) return shown(value);
    const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+$)/g, "_");
    return value < 0 ? `-${digits}` : digits;
  }

  function validateInt32(value: unknown, name: string, min = -2147483648, max = 2147483647): number {
    if (typeof value !== "number") throw argType(name, "number", value);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    const rule = Number.isInteger(value) ? `>= ${min} && <= ${max}` : "an integer";
    throw coded(new RangeError(`The value of "${name}" is out of range. It must be ${rule}. Received ${received(value)}`), "ERR_OUT_OF_RANGE");
  }

  function validateString(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string") throw argType(name, "string", value);
  }

  function validateObject(value: unknown, name: string): asserts value is object {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw argType(name, "object", value);
  }

  function validateFunction(value: unknown, name: string): asserts value is Function {
    if (typeof value !== "function") throw argType(name, "function", value);
  }

  function validateBoolean(value: unknown, name: string): asserts value is boolean {
    if (typeof value !== "boolean") throw argType(name, "boolean", value);
  }

  const isBufferSource = (value: unknown): value is ArrayBuffer | ArrayBufferView => ArrayBuffer.isView(value) || value instanceof ArrayBuffer;

  function stringBytes(value: string, encoding: unknown): Uint8Array {
    if (encoding === undefined || encoding === null || encoding === "buffer") return Buffer.from(value, "utf8");
    if (typeof encoding !== "string" || !Buffer.isEncoding(encoding)) throw coded(new TypeError(`Unknown encoding: ${String(encoding)}`), "ERR_UNKNOWN_ENCODING");
    return Buffer.from(value, encoding);
  }

  function bytes(value: unknown, name: string, encoding?: unknown): Uint8Array {
    if (typeof value === "string") return stringBytes(value, encoding);
    if (isBufferSource(value)) return internal.toUint8(value);
    throw argType(name, "string or an instance of Buffer, TypedArray, or DataView", value);
  }

  function encodeOut(data: Uint8Array, encoding: unknown): BunWasm.BufferBytes | string {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (typeof encoding !== "string" || encoding === "buffer" || !Buffer.isEncoding(encoding)) return buffer;
    return buffer.toString(encoding);
  }

  function secretKey(key: unknown, encoding?: string): Uint8Array {
    // crypto_keys.ts installs the KeyObject test before node:crypto uses this module.
    if (internal.nodeCryptoIsKeyObject(key)) {
      const object = key as { type: string; export(): Uint8Array };
      if (object.type !== "secret") throw coded(new TypeError(`Invalid key object type ${object.type}, expected secret.`), "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
      return object.export();
    }
    if (internal.crypto.isKey(key)) {
      if (key.type !== "secret") throw coded(new TypeError(`Invalid key object type ${key.type}, expected secret.`), "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
      return internal.crypto.decode(String(internal.crypto.record(key).key.k));
    }
    if (typeof key === "string") return stringBytes(key, encoding);
    if (isBufferSource(key)) return internal.toUint8(key);
    throw argType("key", "string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey", key);
  }

  // BoringSSL's error text for errors Bun raises itself (ERR_put_error, then createCryptoError).
  function opensslError(packed: string, library: string, reason: string, code: string): Error {
    const error = new Error(`error:${packed}:${library}:OPENSSL_internal:${reason}`);
    return Object.assign(error, { library, function: "OPENSSL_internal", reason, code });
  }

  return {
    Buffer,
    argType,
    invalidArgValue,
    coded,
    validateString,
    validateObject,
    validateFunction,
    validateBoolean,
    validateInt32,
    isBufferSource,
    bytes,
    encodeOut,
    secretKey,
    opensslError,
    invalidState: (message: string) => coded(new Error(message), "ERR_CRYPTO_INVALID_STATE"),
    operationFailed: (message: string) => coded(new Error(message), "ERR_CRYPTO_OPERATION_FAILED"),
  } satisfies NodeCrypto.Args;
});
