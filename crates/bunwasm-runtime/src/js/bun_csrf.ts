// Bun.CSRF: the option handling of Bun's src/runtime/api/csrf_jsc.rs over the native port of
// src/csrf/lib.rs in csrf.rs (docs/bun-patches/bun-csrf.md). Randomness, the clock and the
// signature check stay native, so replacing crypto.getRandomValues or Date.now changes nothing.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000;
  // evp::lookup_ignore_case, limited to the algorithms csrf_jsc.rs allows.
  const ALGORITHMS: Record<string, string> = {
    blake2b256: "blake2b256", blake2b512: "blake2b512", sha256: "sha256", "sha-256": "sha256", sha384: "sha384",
    "sha-384": "sha384", sha512: "sha512", "sha-512": "sha512", "sha512-256": "sha512-256", "sha-512/256": "sha512-256", "sha-512_256": "sha512-256",
  };
  type Format = "base64" | "base64url" | "hex";
  type Options = Record<string, unknown>;

  // JSC's is_object: a function with properties is an options object too.
  const isObject = (value: unknown): value is Options => value !== null && (typeof value === "object" || typeof value === "function");
  const typeError = (message: string) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  // Node's "Received ..." description of an argument.
  function describe(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") return `an instance of ${(value as object).constructor?.name ?? "Object"}`;
    return `type ${typeof value} (${typeof value === "string" ? `'${value}'` : String(value)})`;
  }

  // validate_integer_range::<u64>: a number, an integer, 0 to 2^53 - 1.
  function duration(options: Options, field: string): number | undefined {
    const value = options[field.slice(field.indexOf(".") + 1)];
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw typeError(`The "${field}" property must be of type number. Received ${describe(value)}`);
    const range = (expected: string) => Object.assign(new RangeError(`The value of "${field}" is out of range. It must be ${expected}. Received ${value}`), { code: "ERR_OUT_OF_RANGE" });
    if (!Number.isInteger(value)) throw range("an integer");
    if (value < 0 || value > Number.MAX_SAFE_INTEGER) throw range(`>= 0 && <= ${Number.MAX_SAFE_INTEGER}`);
    return value;
  }

  // Node's encoding names, case-insensitive; csrf_jsc.rs allows three of them.
  function format(options: Options): Format | undefined {
    const value = options.encoding;
    if (value === undefined) return undefined;
    const name = typeof value === "string" ? value.toLowerCase() : "";
    if (name === "base64" || name === "base64url" || name === "hex") return name;
    if (value === "") return "base64url";
    throw typeError("Invalid format: must be 'base64', 'base64url', or 'hex'");
  }

  function algorithm(options: Options, owner: string): string | undefined {
    const value = options.algorithm;
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw typeError(`${owner}.algorithm must be a string`);
    const found = ALGORITHMS[value.toLowerCase()];
    if (!found) throw typeError("Algorithm not supported");
    return found;
  }

  // A present, non-null option must be a non-empty string.
  function text(options: Options, field: string, owner: string, empty: string): Uint8Array | undefined {
    const value = options[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw typeError(`${owner}.${field} must be a string`);
    if (!value.length) throw typeError(empty);
    return native.utf8Encode(value);
  }

  function generate(secretValue?: unknown, optionsValue?: unknown): string {
    let secret: Uint8Array | undefined;
    if (secretValue !== undefined) {
      if (typeof secretValue !== "string") throw typeError("secret must be a string");
      if (!secretValue.length) throw typeError("Secret must be a non-empty string");
      secret = native.utf8Encode(secretValue);
    }
    const options = isObject(optionsValue) ? optionsValue : {};
    const expiresIn = duration(options, "CSRFGenerateOptions.expiresIn") ?? DEFAULT_EXPIRATION_MS;
    const sessionId = text(options, "sessionId", "CSRFGenerateOptions", "sessionId must be a non-empty string");
    const encoding = format(options) ?? "base64url";
    const hash = algorithm(options, "CSRFGenerateOptions") ?? "sha256";
    return native.csrfGenerate(hash, encoding, expiresIn, secret, sessionId);
  }

  function verify(token?: unknown, optionsValue?: unknown): boolean {
    if (typeof token !== "string") throw typeError("token must be a string");
    if (!token.length) throw typeError("Token must be a non-empty string");
    const options = isObject(optionsValue) ? optionsValue : {};
    const secret = text(options, "secret", "CSRFVerifyOptions", "Secret must be a non-empty string");
    const sessionId = text(options, "sessionId", "CSRFVerifyOptions", "sessionId must be a non-empty string");
    const maxAge = duration(options, "CSRFVerifyOptions.maxAge") ?? DEFAULT_EXPIRATION_MS;
    const encoding = format(options) ?? "base64url";
    const hash = algorithm(options, "CSRFVerifyOptions") ?? "sha256";
    return native.csrfVerify(native.utf8Encode(token), hash, encoding, maxAge, secret, sessionId);
  }

  return { CSRF: { generate, verify } };
})
