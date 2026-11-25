// Bun.CSRF: generate() and verify(), ported from Bun's src/csrf/lib.rs and the option handling of
// src/runtime/api/csrf_jsc.rs (docs/bun-patches/bun-csrf.md). A token is
// timestamp (8 bytes) + nonce (16) + expiresIn (8) + HMAC of those 32 bytes and the session id.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000;
  const ALGORITHMS: Record<string, string> = {
    blake2b256: "blake2b256", blake2b512: "blake2b512", sha256: "sha256", sha384: "sha384", sha512: "sha512",
    "sha512-256": "sha512-256", sha512_256: "sha512-256",
  };
  type Format = "base64" | "base64url" | "hex";
  type Options = Record<string, unknown>;
  let defaultSecret: Uint8Array | undefined;

  const invalid = (message: string) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  const isObject = (value: unknown): value is Options => value !== null && typeof value === "object";

  function duration(options: Options, field: string): number | undefined {
    const value = options[field];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new RangeError(`The value of "${field}" is out of range. It must be >= 0 and <= ${Number.MAX_SAFE_INTEGER}. Received ${String(value)}`), { code: "ERR_OUT_OF_RANGE" });
    }
    return value;
  }

  function format(options: Options): Format | undefined {
    const value = options.encoding;
    if (value === undefined) return undefined;
    if (value === "base64" || value === "base64url" || value === "hex") return value;
    if (value === "") return "base64url";
    throw invalid("Invalid format: must be 'base64', 'base64url', or 'hex'");
  }

  function algorithm(options: Options): string | undefined {
    const value = options.algorithm;
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw invalid(`The "algorithm" argument must be of type string. Received ${typeof value}`);
    const found = ALGORITHMS[value.toLowerCase()];
    if (!found) throw invalid("Algorithm not supported");
    return found;
  }

  function nonEmpty(options: Options, field: string, message: string): Uint8Array | undefined {
    const value = options[field];
    if (value === undefined || value === null) return undefined;
    const bytes = native.utf8Encode(String(value));
    if (!bytes.length) throw invalid(message);
    return bytes;
  }

  function secretOrDefault(secret: Uint8Array | undefined): Uint8Array {
    if (secret) return secret;
    defaultSecret ??= crypto.getRandomValues(new Uint8Array(16));
    return defaultSecret;
  }

  function sign(secret: Uint8Array, payload: Uint8Array, sessionId: Uint8Array | undefined, hash: string): Uint8Array {
    const message = sessionId ? internal.concatBytes([payload, sessionId]) : payload;
    return native.nodeHmac(hash, secret, message);
  }

  function encode(bytes: Uint8Array, encoding: Format): string {
    const { Buffer } = internal.require("buffer");
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);
  }

  function decode(token: string, encoding: Format): Uint8Array | undefined {
    const { Buffer } = internal.require("buffer");
    if (encoding === "hex") {
      if (token.length % 2 || !/^[0-9a-fA-F]*$/.test(token)) return undefined;
      return Buffer.from(token, "hex");
    }
    const trimmed = token.trim();
    return trimmed ? Buffer.from(trimmed, "base64") : undefined;
  }

  function generate(secretValue?: unknown, optionsValue?: unknown): string {
    let secret: Uint8Array | undefined;
    if (secretValue !== undefined && secretValue !== null) {
      if (typeof secretValue !== "string" || !secretValue.length) throw invalid("Secret must be a non-empty string");
      secret = native.utf8Encode(secretValue);
    }
    const options = isObject(optionsValue) ? optionsValue : {};
    const expiresIn = duration(options, "expiresIn") ?? DEFAULT_EXPIRATION_MS;
    const sessionId = nonEmpty(options, "sessionId", "sessionId must be a non-empty string");
    const encoding = format(options) ?? "base64url";
    const hash = algorithm(options) ?? "sha256";
    const payload = new Uint8Array(32);
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, BigInt(Date.now()));
    crypto.getRandomValues(payload.subarray(8, 24));
    view.setBigUint64(24, BigInt(expiresIn));
    return encode(internal.concatBytes([payload, sign(secretOrDefault(secret), payload, sessionId, hash)]), encoding);
  }

  function expired(timestamp: bigint, limit: number, now: bigint): boolean {
    return limit > 0 && now > timestamp + BigInt(limit);
  }

  function verify(token?: unknown, optionsValue?: unknown): boolean {
    if (token === undefined || token === null) throw invalid("Token is required");
    if (typeof token !== "string") throw invalid("token must be a string");
    if (!token.length) throw invalid("Token must be a non-empty string");
    const options = isObject(optionsValue) ? optionsValue : {};
    const secret = nonEmpty(options, "secret", "Secret must be a non-empty string");
    const sessionId = nonEmpty(options, "sessionId", "sessionId must be a non-empty string");
    const maxAge = duration(options, "maxAge") ?? DEFAULT_EXPIRATION_MS;
    const encoding = format(options) ?? "base64url";
    const hash = algorithm(options) ?? "sha256";
    const decoded = decode(token, encoding);
    if (!decoded || decoded.length < 64) return false;
    const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    const timestamp = view.getBigUint64(0);
    const now = BigInt(Date.now());
    if (expired(timestamp, Number(view.getBigUint64(24)), now) || expired(timestamp, maxAge, now)) return false;
    const payload = decoded.subarray(0, 32);
    const expected = sign(secretOrDefault(secret), payload, sessionId, hash);
    const received = decoded.subarray(32);
    if (received.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ received[index];
    return difference === 0;
  }

  return { CSRF: { generate, verify } };
})
