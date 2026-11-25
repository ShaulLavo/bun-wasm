// Bun.password: argument handling from Bun's src/runtime/crypto/PasswordObject.rs over the
// native argon2/bcrypt port in password.rs (docs/bun-patches/bun-password.md). Bun hashes off
// the JavaScript thread; here the async forms compute on a later event-loop turn.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const UNKNOWN = "unknown algorithm, expected one of: \"bcrypt\", \"argon2id\", \"argon2d\", \"argon2i\" (default is \"argon2id\")";
  const ALGORITHMS = ["argon2id", "argon2d", "argon2i", "bcrypt"];
  // Bun's defaults: argon2id at 64 MiB and 2 passes; bcrypt at cost 10.
  const ARGON2_MEMORY = 65536;
  const ARGON2_TIME = 2;
  const BCRYPT_COST = 10;
  type Params = { algorithm: string; cost: number; memoryCost: number; timeCost: number };

  const typeError = (message: string) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  const truthy = (value: Record<string, unknown>, key: string) => value[key] || undefined;

  function algorithmName(value: unknown, field: string): string {
    if (typeof value !== "string") throw typeError(`Expected ${field} to be a string for 'hash'.`);
    if (!ALGORITHMS.includes(value)) throw typeError(`Expected algorithm to be a ${UNKNOWN} for 'hash'.`);
    return value;
  }

  function integerOption(value: unknown, name: string, check: (n: number) => string | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw typeError(`Expected ${name} to be a number for 'hash'.`);
    const problem = check(value);
    if (problem) throw typeError(problem);
    return value;
  }

  function params(value: unknown): Params {
    const out: Params = { algorithm: "argon2id", cost: BCRYPT_COST, memoryCost: ARGON2_MEMORY, timeCost: ARGON2_TIME };
    if (value === undefined || value === null) return out;
    if (typeof value === "string") return { ...out, algorithm: algorithmName(value, "algorithm") };
    if (typeof value !== "object") throw typeError("PasswordHashOptions must be an object");
    const options = value as Record<string, unknown>;
    const algorithm = truthy(options, "algorithm");
    if (algorithm === undefined) throw typeError("Expected options.algorithm to be a string for 'hash'.");
    out.algorithm = algorithmName(algorithm, "algorithm");
    if (out.algorithm === "bcrypt") {
      out.cost = integerOption(truthy(options, "cost"), "cost", n => Number.isInteger(n) && n >= 4 && n <= 31 ? undefined : "Rounds must be an integer between 4 and 31") ?? BCRYPT_COST;
      return out;
    }
    out.timeCost = integerOption(truthy(options, "timeCost"), "timeCost", n => {
      if (!(n >= 1)) return "Time cost must be greater than 0";
      return Number.isInteger(n) && n <= 0xffffffff ? undefined : "Time cost must be an integer between 1 and 4294967295";
    }) ?? ARGON2_TIME;
    out.memoryCost = integerOption(truthy(options, "memoryCost"), "memoryCost", n => {
      if (!(n >= 8)) return "Memory cost must be at least 8";
      return Number.isInteger(n) && n <= 0xffffffff ? undefined : "Memory cost must be an integer between 8 and 4294967295";
    }) ?? ARGON2_MEMORY;
    return out;
  }

  function bytes(value: unknown, name: string): Uint8Array {
    if (typeof value === "string") return native.utf8Encode(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return new Uint8Array(internal.toUint8(value));
    throw typeError(`${name} must be a string, ArrayBuffer or ArrayBufferView`);
  }

  function prepareHash(password: unknown, algorithm: unknown): () => string {
    const options = params(algorithm);
    const input = bytes(password, "password");
    if (!input.length) throw typeError("password must not be empty");
    return () => native.passwordHash(input, options.algorithm, options.cost, options.memoryCost, options.timeCost);
  }

  // `undefined` when the password or hash is empty: Bun answers false without hashing.
  function prepareVerify(password: unknown, hash: unknown, algorithm: unknown): (() => boolean) | undefined {
    if (algorithm !== undefined && algorithm !== null) {
      if (typeof algorithm !== "string") throw typeError("algorithm must be a string");
      if (!ALGORITHMS.includes(algorithm)) throw typeError(`Expected algorithm to be a ${UNKNOWN} for 'verify'.`);
    }
    const input = bytes(password, "password");
    const encoded = bytes(hash, "hash");
    if (!input.length || !encoded.length) return undefined;
    return () => native.passwordVerify(input, encoded, algorithm ?? undefined);
  }

  // Validation errors throw synchronously, as in Bun; the hash runs on a later turn of the event
  // loop (Bun uses its thread pool), so the call returns a pending promise at once, and
  // computation errors reject. The real timers keep fake timers in tests from holding it back.
  function settle<T>(run: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      internal.realTimers.setImmediate(() => {
        try {
          resolve(run());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  const password = {
    hash(password: unknown, algorithm?: unknown) {
      return settle(prepareHash(password, algorithm));
    },
    hashSync(password: unknown, algorithm?: unknown) {
      return prepareHash(password, algorithm)();
    },
    verify(password: unknown, hash: unknown, algorithm?: unknown) {
      const run = prepareVerify(password, hash, algorithm);
      // An empty password or hash settles at once, as Bun's resolved_promise_value does.
      return run ? settle(run) : Promise.resolve(false);
    },
    verifySync(password: unknown, hash: unknown, algorithm?: unknown) {
      return prepareVerify(password, hash, algorithm)?.() ?? false;
    },
  };
  return { password };
})
