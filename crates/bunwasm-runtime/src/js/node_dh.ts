// node:crypto DiffieHellman, DiffieHellmanGroup, ECDH, checkPrime and generatePrime with the
// argument checks and messages of Bun's JSDiffieHellman*.cpp, JSECDH*.cpp and
// CryptoPrimes.cpp. Keys live here as big-endian bytes; node_dh.rs does the BoringSSL work.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Bytes = Uint8Array;
  type DhState = { prime: Bytes; generator: Bytes; publicKey?: Bytes; privateKey?: Bytes };
  type EcdhState = { nid: number; publicKey?: Bytes; privateKey?: Bytes };
  type Encoded = BunWasm.BufferBytes | string;
  type PrimeCallback = (error: Error | undefined, value?: unknown) => void;
  type PrimeOptions = { safe?: unknown; bigint?: unknown; add?: unknown; rem?: unknown; checks?: unknown };

  const FORMS: Record<string, number> = { compressed: 2, uncompressed: 4, hybrid: 6 };

  return function create() {
    const args: NodeCrypto.Args = internal.require("node_crypto_args");
    const { Buffer, coded } = args;
    const native = internal.native.nodeCrypto;
    const dhStates = new WeakMap<object, DhState>();
    const ecdhStates = new WeakMap<object, EcdhState>();
    const later = (task: () => void) => internal.realTimers.setImmediate(task);

    // BIGNUM bytes as BN_bn2bin writes them: no leading zeros.
    function minimal(bytes: Bytes): Bytes {
      let start = 0;
      while (start < bytes.length && bytes[start] === 0) start++;
      return bytes.slice(start);
    }

    function wordBytes(value: number): Bytes {
      const out: number[] = [];
      for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest % 256);
      return new Uint8Array(out);
    }

    const badGenerator = () => args.opensslError("05000064", "Diffie-Hellman routines", "BAD_GENERATOR", "ERR_OSSL_DH_BAD_GENERATOR");
    const isNumber = (value: unknown): value is number => typeof value === "number";
    const isKeySource = (value: unknown) => typeof value === "string" || args.isBufferSource(value);
    const encodings = (value: unknown) => typeof value === "string" && (value === "buffer" || Buffer.isEncoding(value));

    function dhState(target: object, method: string): DhState {
      const state = dhStates.get(target);
      if (!state) throw coded(new TypeError(`DiffieHellman.prototype.${method} called on an incompatible receiver`), "ERR_INVALID_THIS");
      return state;
    }

    function install(target: object, prime: Bytes, generator: Bytes, flags: number) {
      dhStates.set(target, { prime, generator });
      Object.defineProperty(target, "verifyError", { value: flags, enumerable: true, writable: false, configurable: false });
    }

    function check(target: object, prime: Bytes, generator: Bytes) {
      const flags = native.dhCheck(prime, generator);
      if (flags < 0) throw args.operationFailed("Checking DH parameters failed");
      install(target, prime, generator, flags);
    }

    // DH_check's answer for every RFC 3526 group with generator 2: DH_NOT_SUITABLE_GENERATOR,
    // which BoringSSL reports for any generator it did not choose itself. The primes are
    // constants, so the check (seconds for the larger groups in the guest) is skipped.
    const GROUP_VERIFY_ERROR = 8;

    function generatorBytes(generator: unknown, encoding: unknown): Bytes {
      if (isNumber(generator)) {
        if (generator < 2) throw badGenerator();
        return wordBytes(generator);
      }
      const bytes = minimal(args.bytes(generator, "generator", encoding));
      // A generator too wide for one word is necessarily at least 2.
      if (bytes.length === 0 || (bytes.length === 1 && bytes[0]! < 2)) throw badGenerator();
      return bytes;
    }

    function initDh(target: object, sizeOrKey: unknown, keyEncoding: unknown, generator: unknown, genEncoding: unknown) {
      if (!isNumber(sizeOrKey) && !isKeySource(sizeOrKey)) throw args.argType("sizeOrKey", "number, string, ArrayBuffer, Buffer, TypedArray, or DataView", sizeOrKey);
      if (isNumber(sizeOrKey)) args.validateInt32(sizeOrKey, "sizeOrKey");
      if (keyEncoding && !encodings(keyEncoding)) {
        genEncoding = generator;
        generator = keyEncoding;
        keyEncoding = false;
      }
      if (!generator) generator = 2;
      else if (isNumber(generator)) args.validateInt32(generator, "generator");
      else if (!isKeySource(generator)) throw args.argType("generator", "number, string, ArrayBuffer, Buffer, TypedArray, or DataView", generator);
      if (!isNumber(sizeOrKey)) {
        const prime = minimal(args.bytes(sizeOrKey, "sizeOrKey", keyEncoding || undefined));
        return check(target, prime, generatorBytes(generator, genEncoding));
      }
      if (sizeOrKey < 2) throw args.opensslError("03000067", "bignum routines", "BITS_TOO_SMALL", "ERR_OSSL_BN_BITS_TOO_SMALL");
      if (!isNumber(generator)) throw coded(new TypeError("Second argument must be an int32"), "ERR_INVALID_ARG_TYPE");
      if (generator < 2) throw badGenerator();
      const prime = native.dhParameters(sizeOrKey, generator);
      if (prime === null) throw coded(new TypeError("Invalid DH parameters"), "ERR_INVALID_ARG_VALUE");
      check(target, prime, wordBytes(generator));
    }

    const dhMethods = {
      generateKeys(this: object, encoding?: unknown): Encoded {
        const state = dhState(this, "generateKeys");
        const keys = native.dhGenerate(state.prime, state.generator, state.privateKey ?? null);
        if (keys === null) throw args.operationFailed("Key generation failed");
        [state.publicKey, state.privateKey] = keys;
        return args.encodeOut(keys[0], encoding);
      },
      computeSecret(this: object, key: unknown, inputEncoding?: unknown, outputEncoding?: unknown): Encoded {
        const state = dhState(this, "computeSecret");
        const peer = args.bytes(key, "key", inputEncoding);
        const secret = native.dhSecret(state.prime, state.generator, state.privateKey ?? null, peer);
        if (typeof secret === "number") {
          const message = secret < 0 ? "Unspecified validation error" : "Supplied key is invalid";
          throw coded(new RangeError(message), "ERR_CRYPTO_INVALID_KEYTYPE");
        }
        if (secret === null) throw args.operationFailed("Failed to compute shared secret");
        return args.encodeOut(secret, outputEncoding);
      },
      getPrime(this: object, encoding?: unknown): Encoded {
        return args.encodeOut(dhState(this, "getPrime").prime, encoding);
      },
      getGenerator(this: object, encoding?: unknown): Encoded {
        return args.encodeOut(dhState(this, "getGenerator").generator, encoding);
      },
      getPublicKey(this: object, encoding?: unknown): Encoded {
        const key = dhState(this, "getPublicKey").publicKey;
        if (key === undefined) throw args.invalidState("No public key - did you forget to generate one?");
        return args.encodeOut(key, encoding);
      },
      getPrivateKey(this: object, encoding?: unknown): Encoded {
        const key = dhState(this, "getPrivateKey").privateKey;
        if (key === undefined) throw args.invalidState("No private key - did you forget to generate one?");
        return args.encodeOut(key, encoding);
      },
      setPublicKey(this: object, key: unknown, encoding?: unknown) {
        dhState(this, "setPublicKey").publicKey = minimal(args.bytes(key, "key", encoding));
        return this;
      },
      setPrivateKey(this: object, key: unknown, encoding?: unknown) {
        dhState(this, "setPrivateKey").privateKey = minimal(args.bytes(key, "key", encoding));
        return this;
      },
    };

    function DiffieHellman(this: object, sizeOrKey: unknown, keyEncoding?: unknown, generator?: unknown, genEncoding?: unknown): object | void {
      if (!new.target) return new (DiffieHellman as unknown as new (...a: unknown[]) => object)(sizeOrKey, keyEncoding, generator, genEncoding);
      initDh(this, sizeOrKey, keyEncoding, generator, genEncoding);
    }

    function DiffieHellmanGroup(this: object, name: unknown): object | void {
      if (!new.target) return new (DiffieHellmanGroup as unknown as new (...a: unknown[]) => object)(name);
      args.validateString(name, "group name");
      const prime = native.dhGroup(name);
      if (prime === null) throw coded(new Error("Unknown DH group"), "ERR_CRYPTO_UNKNOWN_DH_GROUP");
      install(this, prime, new Uint8Array([2]), GROUP_VERIFY_ERROR);
    }

    Object.assign(DiffieHellman.prototype, dhMethods);
    // A group's keys come only from generateKeys(), as in Node.
    Object.assign(DiffieHellmanGroup.prototype, Object.fromEntries(Object.entries(dhMethods).filter(([name]) => !name.startsWith("set"))));

    function ecdhState(target: object, method: string): EcdhState {
      const state = ecdhStates.get(target);
      if (!state) throw coded(new TypeError(`ECDH.prototype.${method} called on an incompatible receiver`), "ERR_INVALID_THIS");
      return state;
    }

    function form(format: unknown): number {
      if (!format) return FORMS.uncompressed!;
      const name = String(format);
      const value = Object.hasOwn(FORMS, name) ? FORMS[name] : undefined;
      if (value === undefined) throw coded(new TypeError(`Invalid ECDH format: ${name}`), "ERR_CRYPTO_ECDH_INVALID_FORMAT");
      return value;
    }

    function missingKey(method: string, count: number) {
      if (count < 1) throw coded(new TypeError(`ECDH.prototype.${method} requires a key argument`), "ERR_MISSING_ARGS");
    }

    function publicKeyOf(state: EcdhState, encoding: unknown, format: unknown): Encoded {
      const wanted = form(format);
      if (state.publicKey === undefined) throw args.invalidState("Failed to get ECDH public key");
      const point = wanted === FORMS.uncompressed ? state.publicKey : native.ecdhPoint(state.nid, state.publicKey, wanted);
      if (point === 2) throw args.operationFailed("Failed to determine size for public key encoding");
      if (typeof point === "number") throw args.operationFailed("Failed to encode public key");
      return args.encodeOut(point, encoding);
    }

    const ecdhMethods = {
      generateKeys(this: object, encoding?: unknown, format?: unknown): Encoded {
        const state = ecdhState(this, "generateKeys");
        const keys = native.ecdhGenerate(state.nid);
        if (keys === null || keys[1] === null) throw args.operationFailed("Failed to generate ECDH key pair");
        [state.privateKey, state.publicKey] = keys as [Bytes, Bytes];
        return publicKeyOf(state, encoding, format);
      },
      computeSecret(this: object, key: unknown, inputEncoding?: unknown, outputEncoding?: unknown): Encoded {
        const state = ecdhState(this, "computeSecret");
        missingKey("computeSecret", arguments.length);
        const peer = args.bytes(key, "key", inputEncoding);
        const secret = native.ecdhSecret(state.nid, state.privateKey ?? null, state.publicKey ?? null, peer);
        if (secret === 1) throw coded(new RangeError("Invalid key pair"), "ERR_CRYPTO_INVALID_KEYPAIR");
        if (secret === 2) throw coded(new Error("Public key is not valid for specified curve"), "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY");
        if (typeof secret === "number") throw args.operationFailed("Failed to compute ECDH key");
        return args.encodeOut(secret, outputEncoding);
      },
      getPublicKey(this: object, encoding?: unknown, format?: unknown): Encoded {
        return publicKeyOf(ecdhState(this, "getPublicKey"), encoding, format);
      },
      getPrivateKey(this: object, encoding?: unknown): Encoded {
        const key = ecdhState(this, "getPrivateKey").privateKey;
        if (key === undefined) throw args.invalidState("Failed to get ECDH private key");
        return args.encodeOut(key, encoding);
      },
      setPublicKey(this: object, key: unknown, encoding?: unknown) {
        const state = ecdhState(this, "setPublicKey");
        missingKey("setPublicKey", arguments.length);
        const point = native.ecdhPoint(state.nid, args.bytes(key, "key", encoding), FORMS.uncompressed!);
        if (typeof point === "number") throw args.operationFailed("Failed to set EC_POINT from buffer");
        state.publicKey = point;
        return this;
      },
      setPrivateKey(this: object, key: unknown, encoding?: unknown) {
        const state = ecdhState(this, "setPrivateKey");
        missingKey("setPrivateKey", arguments.length);
        const keys = native.ecdhPrivate(state.nid, args.bytes(key, "key", encoding));
        if (keys === 1) throw coded(new RangeError("Private key is not valid for specified curve"), "ERR_CRYPTO_INVALID_KEYTYPE");
        if (typeof keys === "number" || keys[1] === null) throw args.operationFailed("Failed to compute public key from private key");
        [state.privateKey, state.publicKey] = keys as [Bytes, Bytes];
        return this;
      },
    };

    function curveNid(curve: string, unavailable: () => Error): number {
      const nid = native.ecdhCurve(curve);
      if (nid === 0) throw coded(new TypeError("Invalid EC curve name"), "ERR_CRYPTO_INVALID_CURVE");
      if (nid < 0) throw unavailable();
      return nid;
    }

    function ECDH(this: object, curve: unknown): object | void {
      if (!new.target) return new (ECDH as unknown as new (...a: unknown[]) => object)(curve);
      args.validateString(curve, "curve");
      ecdhStates.set(this, { nid: curveNid(curve, () => args.operationFailed("Failed to create key using named curve")) });
    }
    Object.assign(ECDH.prototype, ecdhMethods);
    // util.deprecate's wrapper (DEP0031), without loading node:util with node:crypto.
    let warned = false;
    ECDH.prototype.setPublicKey = function deprecated(this: object, ...rest: unknown[]) {
      if (!warned) {
        warned = true;
        globalThis.process.emitWarning?.("ecdh.setPublicKey() is deprecated.", "DeprecationWarning", "DEP0031");
      }
      return Reflect.apply(ecdhMethods.setPublicKey, this, rest);
    };
    Object.defineProperty(ECDH, "convertKey", {
      value: function convertKey(key: unknown, curve: unknown, inputEncoding?: unknown, outputEncoding?: unknown, format?: unknown): Encoded {
        args.validateString(curve, "curve");
        const bytes = args.bytes(key, "key", inputEncoding);
        const wanted = form(format);
        const nid = curveNid(curve, () => new Error("Failed to get EC_GROUP"));
        const point = native.ecdhPoint(nid, bytes, wanted);
        if (point === 1) throw args.operationFailed("Failed to convert Buffer to EC_POINT");
        if (point === 2) throw args.operationFailed("Failed to get public key length");
        if (typeof point === "number") throw args.operationFailed("Failed to get public key");
        return args.encodeOut(point, outputEncoding);
      },
      writable: true,
      configurable: true,
    });

    // Node's unsignedBigIntToBuffer.
    function bigintBytes(value: bigint, name: string): Bytes {
      if (value < 0n) throw coded(new RangeError(`The value of "${name}" is out of range. It must be >= 0. Received ${value}n`), "ERR_OUT_OF_RANGE");
      const hex = value.toString(16);
      return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
    }

    function candidateBytes(candidate: unknown): Bytes {
      if (typeof candidate === "bigint") return bigintBytes(candidate, "candidate");
      // A copy: the options getters run later and may change the caller's buffer, and Bun
      // checks the bytes passed at call time.
      if (typeof candidate === "string" || args.isBufferSource(candidate)) return args.bytes(candidate, "candidate").slice();
      throw args.argType("candidate", "string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", candidate);
    }

    function primeChecks(options: unknown): number {
      if (options === undefined) return 0;
      args.validateObject(options, "options");
      const checks = (options as PrimeOptions).checks;
      return checks === undefined ? 0 : args.validateInt32(checks, "options.checks", 0);
    }

    function checkPrimeResult(bytes: Bytes, checks: number): boolean {
      const result = native.primeCheck(bytes, checks);
      if (result < 0) throw args.operationFailed("could not check prime");
      return result > 0;
    }

    function primeAddend(value: unknown, name: string): Bytes | null {
      if (value === undefined) return null;
      if (typeof value === "bigint") return bigintBytes(value, name);
      if (ArrayBuffer.isView(value)) return internal.toUint8(value);
      throw args.argType(name, "ArrayBuffer, Buffer, TypedArray, DataView, or bigint", value);
    }

    // Bun's jsGeneratePrime argument checks; returns the generation for now or later.
    function preparePrime(size: unknown, options: unknown): () => unknown {
      const bits = args.validateInt32(size, "size", 1);
      if (options !== undefined) args.validateObject(options, "options");
      const { safe, bigint, add, rem } = (options ?? {}) as PrimeOptions;
      if (safe !== undefined) args.validateBoolean(safe, "options.safe");
      if (bigint !== undefined) args.validateBoolean(bigint, "options.bigint");
      const addBytes = primeAddend(add, "options.add");
      const remBytes = primeAddend(rem, "options.rem");
      const fit = addBytes === null ? 0 : native.primeOptions(bits, addBytes, remBytes);
      if (fit !== 0) throw coded(new RangeError(fit === 1 ? "invalid options.add" : "invalid options.rem"), "ERR_OUT_OF_RANGE");
      return () => {
        const prime = native.primeGenerate(bits, safe === true, addBytes, remBytes);
        if (prime === null) throw args.operationFailed("could not generate prime");
        if (bigint === true) return BigInt(`0x${Buffer.from(prime).toString("hex")}`);
        return prime.slice().buffer;
      };
    }

    function settle(callback: PrimeCallback, run: () => unknown) {
      later(() => {
        let value: unknown;
        try {
          value = run();
        } catch (error) {
          callback(error as Error);
          return;
        }
        callback(undefined, value);
      });
    }

    // crypto.diffieHellman with the checks of Bun's CryptoDhJob.cpp, over the key types the
    // KeyObject layer (crypto_keys.ts) holds: EC P-256, P-384 and P-521, and X25519.
    type KeyObjectLike = { type: string; asymmetricKeyType?: string; export(options: { format: "jwk" }): JsonWebKey };
    const CURVE_NIDS: Partial<Record<string, number>> = { "P-256": 415, "P-384": 715, "P-521": 716 };
    const base64url = (value: unknown) => Buffer.from(String(value), "base64url");
    const point = (key: JsonWebKey) => Buffer.concat([new Uint8Array([4]), base64url(key.x), base64url(key.y)]);

    function derivePair(own: JsonWebKey, peer: JsonWebKey): Bytes | null {
      if (own.kty === "OKP") return native.x25519(base64url(own.d), base64url(peer.x));
      const nid = CURVE_NIDS[String(own.crv)];
      if (nid === undefined || own.crv !== peer.crv) return null;
      const secret = native.ecdhSecret(nid, base64url(own.d), point(own), point(peer));
      return typeof secret === "number" ? null : secret;
    }

    function keyObject(value: unknown, name: string): KeyObjectLike {
      if (!internal.nodeCryptoIsKeyObject(value)) throw args.invalidArgValue(name, value);
      return value as KeyObjectLike;
    }

    function diffieHellman(options: unknown, callback?: unknown) {
      args.validateObject(options, "options");
      if (callback !== undefined) args.validateFunction(callback, "callback");
      const { privateKey, publicKey } = options as { privateKey?: unknown; publicKey?: unknown };
      const own = keyObject(privateKey, "options.privateKey");
      const peer = keyObject(publicKey, "options.publicKey");
      if (own.type !== "private") throw coded(new TypeError(`Invalid key object type ${own.type}, expected private.`), "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
      if (peer.type === "secret") throw coded(new TypeError("Invalid key object type secret, expected private or public."), "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
      const kind = own.asymmetricKeyType;
      if (kind !== peer.asymmetricKeyType || (kind !== "ec" && kind !== "x25519")) throw args.invalidArgValue("options.privateKey", privateKey, "must be a supported key type");
      const secret = derivePair(own.export({ format: "jwk" }), peer.export({ format: "jwk" }));
      const failure = () => args.operationFailed("diffieHellman operation failed");
      if (callback === undefined) {
        if (secret === null) throw failure();
        return Buffer.from(secret);
      }
      const done = callback as (error: Error | null, secret?: BunWasm.BufferBytes) => void;
      later(() => (secret === null ? done(failure()) : done(null, Buffer.from(secret))));
      return undefined;
    }

    function optionsAndCallback(options: unknown, callback: unknown): [unknown, PrimeCallback] {
      if (typeof options === "function") return [undefined, options as PrimeCallback];
      return [options, callback as PrimeCallback];
    }

    return {
      DiffieHellman,
      DiffieHellmanGroup,
      getDiffieHellman: DiffieHellmanGroup,
      createDiffieHellmanGroup: DiffieHellmanGroup,
      createDiffieHellman: function createDiffieHellman(sizeOrKey: unknown, keyEncoding?: unknown, generator?: unknown, genEncoding?: unknown) {
        return new (DiffieHellman as unknown as new (...a: unknown[]) => object)(sizeOrKey, keyEncoding, generator, genEncoding);
      },
      ECDH,
      createECDH: function createECDH(curve: unknown) {
        return new (ECDH as unknown as new (...a: unknown[]) => object)(curve);
      },
      diffieHellman,
      getCurves: function getCurves() {
        return ["secp224r1", "prime256v1", "secp384r1", "secp521r1"];
      },
      checkPrimeSync: function checkPrimeSync(candidate: unknown, options?: unknown) {
        const bytes = candidateBytes(candidate);
        return checkPrimeResult(bytes, primeChecks(options));
      },
      checkPrime: function checkPrime(candidate: unknown, options?: unknown, callback?: unknown) {
        const bytes = candidateBytes(candidate);
        const [given, done] = optionsAndCallback(options, callback);
        args.validateFunction(done, "callback");
        const checks = primeChecks(given);
        settle(done, () => checkPrimeResult(bytes, checks));
      },
      generatePrimeSync: function generatePrimeSync(size: unknown, options?: unknown) {
        return preparePrime(size, options)();
      },
      generatePrime: function generatePrime(size: unknown, options?: unknown, callback?: unknown) {
        args.validateInt32(size, "size", 1);
        const [given, done] = optionsAndCallback(options, callback);
        args.validateFunction(done, "callback");
        settle(done, preparePrime(size, given));
      },
    };
  };
});
