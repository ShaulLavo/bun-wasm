declare namespace CryptoKeys {
  type Buffer = BunWasm.BufferBytes;
  type BufferConstructor = BunWasm.BufferConstructor & {
    alloc(size: number): Buffer;
    concat(chunks: readonly Uint8Array[]): Buffer;
  };
  type Input = string | ArrayBuffer | ArrayBufferView;
  type InputBytes = (data: Input, encoding?: string) => Uint8Array;
  type TimingSafeEqual = (a: Buffer, b: Buffer) => boolean;
  type KeyType = "secret" | "private" | "public";
  type ManagedCryptoKey = CryptoKey & { algorithm: Algorithm };
  type Algorithm = BunWasm.CryptoParameters & { hash?: globalThis.Algorithm };
  type OperationAlgorithm = Algorithm & { saltLength?: number; der?: boolean };
  type KeyMaterial = JsonWebKey & { kty: string };
  type NativeRecord = Omit<ReturnType<BunWasm.CryptoHostBridge["record"]>, "algorithm" | "key"> & {
    algorithm: Algorithm;
    key: KeyMaterial;
    type: KeyType;
    nativeKey?: ManagedCryptoKey;
  };
  type Record = Pick<NativeRecord, "algorithm" | "key" | "type" | "nativeKey">;
  type BackendResult = { key?: KeyMaterial; data?: string; verified?: boolean };
  interface Crypto extends BunWasm.CryptoHostBridge {
    record(key: CryptoKey): NativeRecord;
    makeKey(algorithm: Algorithm, type: KeyType, extractable: boolean, usages: KeyUsage[], key: KeyMaterial): ManagedCryptoKey;
    generate(algorithm: BunWasm.CryptoAlgorithm, extractable: boolean, usages: KeyUsage[]): { privateKey: ManagedCryptoKey; publicKey: ManagedCryptoKey };
    importKey(format: string, data: BunWasm.CryptoImportData | ArrayBuffer | ArrayBufferView, algorithm: BunWasm.CryptoAlgorithm, extractable: boolean, usages: KeyUsage[]): ManagedCryptoKey;
    exportKey(format: string, key: CryptoKey): ArrayBuffer;
    deriveBits(algorithm: BunWasm.CryptoAlgorithm, key: CryptoKey, length: number): ArrayBuffer;
    backend(operation: string, algorithm: object, extra?: object): BackendResult;
    algorithm(algorithm: BunWasm.CryptoAlgorithm): Algorithm;
    keyAlgorithm(algorithm: Algorithm, key: KeyMaterial): Algorithm;
  }
  type Writable = BunWasm.WorkerWritable;
  type WritableConstructor = new(options?: unknown) => Writable;
  interface Internal extends Pick<BunWasm.Internal, "realTimers"> {
    crypto: Crypto;
    native: BunWasm.Native & { randomBytes(size: number): Uint8Array };
    nodeCryptoIsKeyObject(value: unknown): boolean;
    builtin(name: "node:stream"): { Writable: WritableConstructor };
  }
  type ExportType = "pkcs8" | "spki" | "pkcs1" | "sec1";
  type ExportOptions = {
    format?: "jwk" | "pem" | "der";
    type?: ExportType;
    cipher?: string;
    passphrase?: Input;
  };
  type KeyOptions = {
    key: Input | KeyObject | CryptoKey | JsonWebKey;
    format?: "jwk" | "pem" | "der";
    type?: ExportType;
    passphrase?: Input;
    padding?: number;
    saltLength?: number;
    dsaEncoding?: "der" | "ieee-p1363";
    oaepHash?: string;
    oaepLabel?: Input;
  };
  type KeyInput = KeyOptions | Input | KeyObject | CryptoKey;
  type GeneratePairType = "rsa" | "ec" | "ed25519" | "x25519";
  type GeneratePairOptions = {
    modulusLength?: number;
    publicExponent?: number;
    hashAlgorithm?: string;
    namedCurve?: string;
    privateKeyEncoding?: ExportOptions;
    publicKeyEncoding?: ExportOptions;
  };
  type KeyPairValue = KeyObject | Buffer | string | JsonWebKey;
  type KeyPair<Value = KeyPairValue> = { privateKey: Value; publicKey: Value };
  type GenerateKeyCallback = (error: Error | null, key: KeyObject) => unknown;
  type GeneratePairCallback = (error: Error | null, publicKey: KeyPairValue, privateKey: KeyPairValue) => unknown;
  type SignCallback = (error: Error | null, signature: Buffer) => unknown;
  type VerifyCallback = (error: Error | null, verified: boolean) => unknown;
  type PemData = { format: ExportType; bytes: Buffer; private: boolean };
  interface KeyObject {
    readonly type: KeyType;
    readonly symmetricKeySize: number | undefined;
    readonly asymmetricKeyType: string | undefined;
    export(options?: ExportOptions): Buffer | string | JsonWebKey;
  }
}
(function (internal: CryptoKeys.Internal) {
  "use strict";
  return (Buffer: CryptoKeys.BufferConstructor, inputBytes: CryptoKeys.InputBytes, timingSafeEqual: CryptoKeys.TimingSafeEqual) => {
    const c = internal.crypto;
    const records = new WeakMap<KeyObject, CryptoKeys.Record>();
    internal.nodeCryptoIsKeyObject = (value: unknown) => records.has(value as KeyObject);
    const constants = {
      RSA_PKCS1_PADDING: 1,
      RSA_NO_PADDING: 3,
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PSS_PADDING: 6,
      RSA_PSS_SALTLEN_DIGEST: -1,
      RSA_PSS_SALTLEN_AUTO: -2,
      RSA_PSS_SALTLEN_MAX_SIGN: -2,
    };
    const error = (message: string) =>
      Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
    const family = (a: { name: string }): string =>
      a.name.startsWith("RSA")
        ? "rsa"
        : a.name === "ECDSA"
          ? "ec"
          : a.name.toLowerCase();
    const hash = (name: unknown): string => {
      const normalized = String(name)
        .toUpperCase()
        .replace(/^RSA-/, "")
        .replace(/^SHA(\d)/, "SHA-$1");
      if (
        !["SHA-1", "SHA-224", "SHA-256", "SHA-384", "SHA-512"].includes(
          normalized,
        )
      )
        throw Object.assign(new TypeError("Invalid digest"), {
          code: "ERR_CRYPTO_INVALID_DIGEST",
        });
      return normalized;
    };
    function nodeRecord(key: unknown): CryptoKeys.Record {
      const r = records.get(key as KeyObject);
      if (!r) throw error("Expected a KeyObject");
      return r;
    }
    function fromCrypto(key: CryptoKey): KeyObject {
      const r = c.record(key);
      return make({ ...r, algorithm: r.algorithm, key: r.key });
    }
    function make(r: CryptoKeys.Record): KeyObject {
      const key = Object.create(KeyObject.prototype) as KeyObject;
      const algorithm: CryptoKeys.Algorithm =
        r.key.kty === "RSA"
          ? { ...r.algorithm, name: "RSASSA-PKCS1-v1_5" }
          : r.key.kty === "EC"
            ? { name: "ECDSA", namedCurve: r.algorithm.namedCurve }
            : r.algorithm;
      records.set(key, { ...r, algorithm });
      return key;
    }
    function equalityBytes(key: KeyObject): CryptoKeys.Buffer {
      const r = nodeRecord(key);
      if (r.type === "secret") return Buffer.from(c.decode(r.key.k));
      return importAsymmetric(key, false).export({
        format: "der",
        type: "spki",
      });
    }
    class KeyObject {
      constructor() {
        throw new TypeError("Illegal constructor");
      }
      static from(key: CryptoKey): KeyObject {
        return fromCrypto(key);
      }
      get type(): CryptoKeys.KeyType {
        return nodeRecord(this).type;
      }
      get symmetricKeySize(): number | undefined {
        const r = nodeRecord(this);
        return r.type === "secret" ? c.decode(r.key.k).length : undefined;
      }
      get asymmetricKeyType(): string | undefined {
        const r = nodeRecord(this);
        return r.type === "secret" ? undefined : family(r.algorithm);
      }
      get asymmetricKeyDetails() {
        const r = nodeRecord(this),
          a = r.algorithm;
        if (r.type === "secret") return undefined;
        if (a.modulusLength)
          return {
            modulusLength: a.modulusLength,
            publicExponent: a.publicExponent!.reduce(
              (n, b) => n * 256n + BigInt(b),
              0n,
            ),
          };
        if (a.namedCurve)
          return {
            namedCurve: a.namedCurve === "P-256" ? "prime256v1" : "secp384r1",
          };
        return {};
      }
      export(options: CryptoKeys.ExportOptions & { format: "jwk" }): JsonWebKey;
      export(options: CryptoKeys.ExportOptions & { format: "der" }): CryptoKeys.Buffer;
      export(options: CryptoKeys.ExportOptions & { format: "pem" }): string;
      export(options?: CryptoKeys.ExportOptions): CryptoKeys.Buffer | string | JsonWebKey;
      export(options?: CryptoKeys.ExportOptions): CryptoKeys.Buffer | string | JsonWebKey {
        const r = nodeRecord(this);
        const encrypted =
          options?.cipher !== undefined || options?.passphrase !== undefined;
        if (encrypted && (r.type !== "private" || options?.format === "jwk"))
          throw Object.assign(
            new TypeError("Key encoding does not support encryption"),
            { code: "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS" },
          );
        if (r.type === "secret" && options?.format !== "jwk")
          return Buffer.from(c.decode(r.key.k));
        const format = options?.format || "pem";
        if (format === "jwk") return { ...r.key };
        if (r.type === "secret" || !["pem", "der"].includes(format))
          throw error("Invalid key format");
        const type = options?.type || (r.type === "private" ? "pkcs8" : "spki");
        const key = c.makeKey(
          r.algorithm,
          r.type,
          true,
          r.type === "private"
            ? privateUsages(r.algorithm)
            : publicUsages(r.algorithm),
          r.key,
        );
        if (encrypted) {
          if (
            typeof options!.cipher !== "string" ||
            options!.passphrase === undefined
          )
            throw Object.assign(
              new TypeError(
                `The property 'options.cipher' is invalid. Received ${String(options!.cipher)}`,
              ),
              { code: "ERR_INVALID_ARG_VALUE" },
            );
          const mode =
            format === "der"
              ? type === "pkcs8"
                ? 3
                : undefined
              : ({ pkcs8: 2, pkcs1: 4, sec1: 5 } as Partial<Record<CryptoKeys.ExportType, number>>)[type];
          if (mode === undefined)
            throw Object.assign(
              new TypeError("Key encoding does not support encryption"),
              { code: "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS" },
            );
          const encoded = keyEncoding(
            mode,
            c.exportKey("pkcs8", key),
            options!.passphrase,
            options!.cipher,
          );
          return format === "pem" ? encoded.toString() : encoded;
        }
        const der = Buffer.from(
          type === "pkcs1" || type === "sec1"
            ? c.decode(
                c.backend("export", r.algorithm, {
                  format: type === "pkcs1" ? `pkcs1-${r.type}` : type,
                  key: r.key,
                }).data,
              )
            : c.exportKey(type, key),
        );
        if (format === "der") return der;
        const label = {
          pkcs8: "PRIVATE KEY",
          spki: "PUBLIC KEY",
          pkcs1: r.type === "private" ? "RSA PRIVATE KEY" : "RSA PUBLIC KEY",
          sec1: "EC PRIVATE KEY",
        }[type];
        const encoded = der
          .toString("base64")
          .match(/.{1,64}/g)!
          .join("\n");
        return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----\n`;
      }
      equals(other: unknown): boolean {
        if (!records.has(other as KeyObject))
          throw Object.assign(
            new TypeError(
              `The "otherKeyObject" argument must be an instance of KeyObject. Received type ${typeof other} (${String(other)})`,
            ),
            { code: "ERR_INVALID_ARG_TYPE" },
          );
        const r = nodeRecord(this),
          b = nodeRecord(other);
        if (r.type !== b.type) return false;
        const aBytes = equalityBytes(this),
          bBytes = equalityBytes(other as KeyObject);
        return (
          aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes)
        );
      }
      toCryptoKey(algorithm: BunWasm.CryptoAlgorithm, extractable: boolean, keyUsages: KeyUsage[]): CryptoKey {
        const r = nodeRecord(this);
        const converted = c.importKey(
          r.type === "secret" ? "raw" : "jwk",
          r.type === "secret" ? c.decode(r.key.k) : { ...r.key },
          algorithm,
          extractable,
          keyUsages,
        );
        if (!r.nativeKey) return converted;
        const requested = c.record(converted), original = r.nativeKey;
        const a = requested.algorithm, b = original.algorithm;
        const sameAlgorithm = (["name", "namedCurve", "length", "modulusLength"] satisfies (keyof CryptoKeys.Algorithm)[])
          .every(field => a[field] === b[field]) && a.hash?.name === b.hash?.name;
        const samePolicy = requested.extractable === original.extractable &&
          requested.usages.length === original.usages.length &&
          requested.usages.every(usage => original.usages.includes(usage));
        return sameAlgorithm && samePolicy ? original : converted;
      }
      get [Symbol.toStringTag]() {
        return "KeyObject";
      }
    }
    function privateUsages(a: { name: string }): KeyUsage[] {
      return ["ECDH", "X25519"].includes(a.name)
        ? ["deriveBits"]
        : a.name === "RSA-OAEP"
          ? ["decrypt"]
          : ["sign"];
    }
    function publicUsages(a: { name: string }): KeyUsage[] {
      return ["ECDH", "X25519"].includes(a.name)
        ? []
        : a.name === "RSA-OAEP"
          ? ["encrypt"]
          : ["verify"];
    }
    function createSecretKey(key: CryptoKeys.Input, encoding?: string): KeyObject {
      const bytes = inputBytes(key, encoding);
      return make({
        type: "secret",
        algorithm: {
          name: "HMAC",
          hash: { name: "SHA-256" },
          length: bytes.length * 8,
        },
        key: { kty: "oct", k: Buffer.from(bytes).toString("base64url") },
      });
    }
    function parseInput(input: CryptoKeys.KeyInput): CryptoKeys.KeyOptions {
      if (
        input &&
        typeof input === "object" &&
        !(input instanceof KeyObject) &&
        !ArrayBuffer.isView(input) &&
        !(input instanceof ArrayBuffer) &&
        !c.isKey(input)
      ) {
        return { ...input } as CryptoKeys.KeyOptions;
      }
      return { key: input };
    }
    function keyEncoding(mode: number, data: CryptoKeys.Input, password?: CryptoKeys.Input, cipher = ""): CryptoKeys.Buffer {
      const pass =
        password === undefined ? Buffer.alloc(0) : inputBytes(password);
      if (pass.byteLength > 1024)
        throw Object.assign(new RangeError("Passphrase is too long"), {
          code: "ERR_OUT_OF_RANGE",
        });
      try {
        return Buffer.from(
          c.decode(
            c.backend(
              "keyEncoding",
              {},
              { mode, data: c.encode(data), password: c.encode(pass), cipher },
            ).data,
          ),
        );
      } catch (error) {
        throw Object.assign(
          new Error(
            mode <= 1
              ? "Failed to decrypt private key"
              : "Failed to encrypt private key",
          ),
          {
            code:
              mode <= 1 ? "ERR_OSSL_BAD_DECRYPT" : "ERR_CRYPTO_UNKNOWN_CIPHER",
            cause: error,
          },
        );
      }
    }
    function readPem(key: unknown, password?: CryptoKeys.Input): CryptoKeys.PemData {
      const pem = typeof key === "string" ? key : Buffer.from(key).toString();
      if (
        pem.includes("ENCRYPTED") ||
        (password !== undefined && pem.includes("PRIVATE KEY"))
      ) {
        if (password === undefined && pem.includes("ENCRYPTED"))
          throw Object.assign(
            new Error("Passphrase required for encrypted key"),
            { code: "ERR_MISSING_PASSPHRASE" },
          );
        return {
          format: "pkcs8",
          bytes: keyEncoding(0, Buffer.from(pem), password),
          private: true,
        };
      }
      const match =
        /-----BEGIN (RSA PRIVATE KEY|RSA PUBLIC KEY|EC PRIVATE KEY|PRIVATE KEY|PUBLIC KEY)-----([\s\S]*?)-----END \1-----/.exec(
          pem,
        );
      if (!match) throw error("Invalid PEM key");
      const format =
        match[1] === "RSA PRIVATE KEY" || match[1] === "RSA PUBLIC KEY"
          ? "pkcs1"
          : match[1] === "EC PRIVATE KEY"
            ? "sec1"
            : match[1] === "PRIVATE KEY"
              ? "pkcs8"
              : "spki";
      return {
        format,
        bytes: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
        private: match[1].endsWith("PRIVATE KEY"),
      };
    }
    function importAsymmetric(input: CryptoKeys.KeyInput, wantPrivate: boolean): KeyObject {
      const options = parseInput(input),
        key = options.key;
      if (key instanceof KeyObject || c.isKey(key)) {
        const r = key instanceof KeyObject ? nodeRecord(key) : c.record(key);
        if (r.type === "secret" || (wantPrivate && r.type !== "private"))
          throw error("Invalid key object type");
        if (wantPrivate) return make({ ...r });
        return publicPart(r);
      }
      const jwk = options.format === "jwk";
      let format: CryptoKeys.ExportType = options.type || (wantPrivate ? "pkcs8" : "spki"),
        bytes: CryptoKeys.Input | JsonWebKey,
        isPrivateEncoding = wantPrivate;
      if (jwk) bytes = key as JsonWebKey;
      else if (typeof key === "string" || options.format !== "der") {
        const decoded = readPem(key, options.passphrase);
        format = decoded.format;
        bytes = decoded.bytes;
        isPrivateEncoding = decoded.private;
      } else {
        bytes = inputBytes(key as CryptoKeys.Input);
        if (
          options.passphrase !== undefined &&
          (options.type === undefined || options.type === "pkcs8")
        ) {
          bytes = keyEncoding(1, bytes, options.passphrase);
          format = "pkcs8";
          isPrivateEncoding = true;
        }
      }
      const attempts = [
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        { name: "ECDSA", namedCurve: "P-256" },
        { name: "ECDSA", namedCurve: "P-384" },
        { name: "Ed25519" },
        { name: "X25519" },
      ];
      for (const a of attempts) {
        try {
          const parsed = c.backend("import", c.algorithm(a), {
            format: jwk
              ? "jwk"
              : format === "pkcs1"
                ? `pkcs1-${isPrivateEncoding ? "private" : "public"}`
                : format,
            data: c.encode(jwk ? Buffer.from(JSON.stringify(key)) : bytes),
          }).key!;
          const type = parsed.d ? "private" : "public";
          const result = c.makeKey(
            c.keyAlgorithm(c.algorithm(a), parsed),
            type,
            true,
            type === "private" ? privateUsages(a) : publicUsages(a),
            parsed,
          );
          const r = c.record(result);
          if (wantPrivate && r.type !== "private") continue;
          return wantPrivate ? fromCrypto(result) : publicPart(r);
        } catch {}
      }
      throw Object.assign(new Error("Failed to read asymmetric key"), {
        code: "ERR_OSSL_ASN1_HEADER_TOO_LONG",
      });
    }
    function publicPart(r: CryptoKeys.Record): KeyObject {
      const key = { ...r.key };
      for (const name of ["d", "p", "q", "dp", "dq", "qi"] satisfies (keyof JsonWebKey)[]) delete key[name];
      return make({ ...r, type: "public", key });
    }
    function createPrivateKey(input: CryptoKeys.KeyInput): KeyObject {
      const options = parseInput(input);
      if (options.key instanceof KeyObject || c.isKey(options.key))
        throw error("The key argument must be encoded key data");
      return importAsymmetric(options, true);
    }
    function createPublicKey(input: CryptoKeys.KeyInput): KeyObject {
      const options = parseInput(input),
        key = options.key;
      const type =
        key instanceof KeyObject
          ? nodeRecord(key).type
          : c.isKey(key)
            ? c.record(key).type
            : undefined;
      if (type === "public")
        throw Object.assign(
          new TypeError("Invalid key object type public, expected private."),
          { code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE" },
        );
      return importAsymmetric(options, false);
    }
    function generateKeySync(type: "hmac" | "aes", options: { length: number }): KeyObject {
      if (type !== "hmac" && type !== "aes")
        throw Object.assign(new TypeError("Unsupported key type"), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      const length = options?.length;
      if (typeof length !== "number")
        throw error("options.length must be a number");
      if (!Number.isInteger(length) || length < 8 || length > 0x7fffffff)
        throw Object.assign(new RangeError("Invalid key length"), {
          code: "ERR_OUT_OF_RANGE",
        });
      if (type === "aes" && ![128, 192, 256].includes(length))
        throw Object.assign(new TypeError("Invalid AES key length"), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      return createSecretKey(
        internal.native.randomBytes(Math.floor(length / 8)),
      );
    }
    function generateKey(type: "hmac" | "aes", options: { length: number }, callback: CryptoKeys.GenerateKeyCallback): void;
    function generateKey(type: "hmac" | "aes", options: { length: number }, callback: CryptoKeys.GenerateKeyCallback): void {
      if (typeof callback !== "function")
        throw error("Callback must be a function");
      internal.realTimers.setImmediate(() => {
        let key: KeyObject;
        try {
          key = generateKeySync(type, options);
        } catch (e) {
          (callback as (error: Error) => unknown)(e as Error);
          return;
        }
        callback(null, key);
      });
    }
    function generateKeyPairSync(type: CryptoKeys.GeneratePairType, options?: CryptoKeys.GeneratePairOptions & { privateKeyEncoding?: undefined; publicKeyEncoding?: undefined }): CryptoKeys.KeyPair<KeyObject>;
    function generateKeyPairSync(type: CryptoKeys.GeneratePairType, options?: CryptoKeys.GeneratePairOptions): CryptoKeys.KeyPair;
    function generateKeyPairSync(type: CryptoKeys.GeneratePairType, options: CryptoKeys.GeneratePairOptions = {}): CryptoKeys.KeyPair {
      let a: BunWasm.CryptoParameters;
      const exponent = options.publicExponent ?? 65537;
      if (
        type === "rsa" &&
        (!Number.isInteger(exponent) ||
          exponent < 3 ||
          exponent > 0xffffffff ||
          exponent % 2 === 0)
      )
        throw Object.assign(new RangeError("Invalid publicExponent"), {
          code: "ERR_OUT_OF_RANGE",
        });
      if (type === "rsa")
        a = {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: options.modulusLength,
          publicExponent: new Uint8Array([
            exponent >>> 24,
            (exponent >>> 16) & 255,
            (exponent >>> 8) & 255,
            exponent & 255,
          ]),
          hash: options.hashAlgorithm || "SHA-256",
        };
      else if (type === "ec")
        a = {
          name: "ECDSA",
          namedCurve:
            ({ prime256v1: "P-256", secp256r1: "P-256", secp384r1: "P-384" } as Record<string, string | undefined>)[
              options.namedCurve!
            ] || options.namedCurve,
        };
      else if (type === "ed25519" || type === "x25519")
        a = { name: type === "ed25519" ? "Ed25519" : "X25519" };
      else
        throw Object.assign(new TypeError(`Unsupported key type ${type}`), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      const pair = c.generate(
        a,
        true,
        privateUsages(a).concat(publicUsages(a)),
      );
      const privateKey = fromCrypto(pair.privateKey),
        publicKey = fromCrypto(pair.publicKey);
      return {
        privateKey: options.privateKeyEncoding
          ? privateKey.export(options.privateKeyEncoding)
          : privateKey,
        publicKey: options.publicKeyEncoding
          ? publicKey.export(options.publicKeyEncoding)
          : publicKey,
      };
    }
    function generateKeyPair(type: CryptoKeys.GeneratePairType, callback: CryptoKeys.GeneratePairCallback): void;
    function generateKeyPair(type: CryptoKeys.GeneratePairType, options: CryptoKeys.GeneratePairOptions | undefined, callback: CryptoKeys.GeneratePairCallback): void;
    function generateKeyPair(type: CryptoKeys.GeneratePairType, options: CryptoKeys.GeneratePairOptions | CryptoKeys.GeneratePairCallback | undefined, callback?: CryptoKeys.GeneratePairCallback): void {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (typeof callback !== "function")
        throw error("Callback must be a function");
      internal.realTimers.setImmediate(() => {
        let pair: CryptoKeys.KeyPair;
        try {
          pair = generateKeyPairSync(type, options);
        } catch (e) {
          (callback as (error: Error) => unknown)(e as Error);
          return;
        }
        callback(null, pair.publicKey, pair.privateKey);
      });
    }
    function signVerify(verify: false, digest: string | null | undefined, data: CryptoKeys.Input, input: CryptoKeys.KeyInput, signature?: undefined): CryptoKeys.Buffer;
    function signVerify(verify: true, digest: string | null | undefined, data: CryptoKeys.Input, input: CryptoKeys.KeyInput, signature: CryptoKeys.Input): boolean;
    function signVerify(verify: boolean, digest: string | null | undefined, data: CryptoKeys.Input, input: CryptoKeys.KeyInput, signature?: CryptoKeys.Input): CryptoKeys.Buffer | boolean {
      const options = parseInput(input);
      const key = importAsymmetric(options, !verify);
      const r = nodeRecord(key),
        a: CryptoKeys.OperationAlgorithm = { ...r.algorithm };
      if (a.name === "X25519") throw error("Key cannot sign");
      if (a.name === "Ed25519" && digest != null)
        throw Object.assign(new Error("Ed25519 does not accept a digest"), {
          code: "ERR_OSSL_EVP_COMMAND_NOT_SUPPORTED",
        });
      if (a.name !== "Ed25519") a.hash = { name: hash(digest) };
      if (family(a) === "rsa") {
        const padding = options.padding;
        if (padding !== undefined &&
            ![constants.RSA_PKCS1_PADDING, constants.RSA_PKCS1_PSS_PADDING].includes(padding))
          throw Object.assign(new Error("Illegal or unsupported padding mode"), {
            code: padding === constants.RSA_NO_PADDING
              ? "ERR_OSSL_EVP_INVALID_PADDING_MODE"
              : "ERR_OSSL_EVP_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE",
          });
        a.name =
          padding === constants.RSA_PKCS1_PSS_PADDING
            ? "RSA-PSS"
            : "RSASSA-PKCS1-v1_5";
        a.saltLength = options.saltLength ?? -2;
      }
      if (
        options.dsaEncoding !== undefined &&
        !["der", "ieee-p1363"].includes(options.dsaEncoding)
      )
        throw Object.assign(
          new TypeError(
            `The property 'options.dsaEncoding' is invalid. Received '${options.dsaEncoding}'`,
          ),
          { code: "ERR_INVALID_ARG_VALUE" },
        );
      a.der = options.dsaEncoding !== "ieee-p1363";
      const result = c.backend(verify ? "verify" : "sign", a, {
        key: r.key,
        data: c.encode(inputBytes(data)),
        ...(verify ? { signature: c.encode(inputBytes(signature!)) } : {}),
      });
      return verify ? result.verified! : Buffer.from(c.decode(result.data));
    }
    function rsaCrypt(decrypt: boolean, inputKey: CryptoKeys.KeyInput, data: CryptoKeys.Input): CryptoKeys.Buffer {
      const options = parseInput(inputKey);
      if (
        options.padding !== undefined &&
        options.padding !== constants.RSA_PKCS1_OAEP_PADDING
      )
        throw Object.assign(
          new Error("Only RSA-OAEP encryption is implemented"),
          { code: "ERR_NOT_SUPPORTED_IN_WASM" },
        );
      const key = importAsymmetric(options, decrypt);
      const r = nodeRecord(key);
      if (r.key.kty !== "RSA") throw error("Expected an RSA key");
      const algorithm = {
        name: "RSA-OAEP",
        hash: { name: hash(options.oaepHash || "sha1") },
        label:
          options.oaepLabel === undefined
            ? ""
            : c.encode(inputBytes(options.oaepLabel)),
      };
      return Buffer.from(
        c.decode(
          c.backend(decrypt ? "decrypt" : "encrypt", algorithm, {
            key: r.key,
            data: c.encode(inputBytes(data)),
          }).data,
        ),
      );
    }
    function sign(algorithm: string | null | undefined, data: CryptoKeys.Input, key: CryptoKeys.KeyInput, callback?: null): CryptoKeys.Buffer;
    function sign(algorithm: string | null | undefined, data: CryptoKeys.Input, key: CryptoKeys.KeyInput, callback: CryptoKeys.SignCallback): void;
    function sign(algorithm: string | null | undefined, data: CryptoKeys.Input, key: CryptoKeys.KeyInput, callback?: CryptoKeys.SignCallback | null): CryptoKeys.Buffer | void {
      if (typeof callback !== "function")
        return signVerify(false, algorithm, data, key);
      internal.realTimers.setImmediate(() => {
        let value: CryptoKeys.Buffer;
        try {
          value = signVerify(false, algorithm, data, key);
        } catch (e) {
          (callback as (error: Error) => unknown)(e as Error);
          return;
        }
        callback(null, value);
      });
    }
    function verify(algorithm: string | null | undefined, data: CryptoKeys.Input, key: CryptoKeys.KeyInput, signature: CryptoKeys.Input, callback?: null): boolean;
    function verify(algorithm: string | null | undefined, data: CryptoKeys.Input, key: CryptoKeys.KeyInput, signature: CryptoKeys.Input, callback: CryptoKeys.VerifyCallback): void;
    function verify(algorithm: string | null | undefined, data: CryptoKeys.Input, key: CryptoKeys.KeyInput, signature: CryptoKeys.Input, callback?: CryptoKeys.VerifyCallback | null): boolean | void {
      if (typeof callback !== "function")
        return signVerify(true, algorithm, data, key, signature);
      internal.realTimers.setImmediate(() => {
        let value: boolean;
        try {
          value = signVerify(true, algorithm, data, key, signature);
        } catch (e) {
          (callback as (error: Error) => unknown)(e as Error);
          return;
        }
        callback(null, value);
      });
    }
    const { Writable } = internal.builtin("node:stream");
    class Sign extends Writable {
      #chunks: CryptoKeys.Buffer[] | null = [];
      declare readonly algorithm: string;
      constructor(algorithm: string, options?: unknown) {
        super(options);
        this.algorithm = hash(algorithm);
      }
      update(data: CryptoKeys.Input, encoding?: string): this {
        if (this.#chunks === null)
          throw Object.assign(new Error("Not initialised"), {
            code: "ERR_CRYPTO_INVALID_STATE",
          });
        this.#chunks.push(Buffer.from(inputBytes(data, encoding)));
        return this;
      }
      _write(data: CryptoKeys.Input, encoding: string, callback: (error?: unknown) => void): void {
        try {
          this.update(data, encoding);
        } catch (e) {
          callback(e as Error);
          return;
        }
        callback();
      }
      finalize(): CryptoKeys.Buffer {
        if (this.#chunks === null)
          throw Object.assign(new Error("Not initialised"), {
            code: "ERR_CRYPTO_INVALID_STATE",
          });
        const data = Buffer.concat(this.#chunks);
        this.#chunks = null;
        return data;
      }
      sign(key: CryptoKeys.KeyInput, encoding?: string): CryptoKeys.Buffer | string {
        const result = sign(this.algorithm, this.finalize(), key);
        return encoding ? result.toString(encoding) : result;
      }
    }
    class Verify extends Sign {
      verify(key: CryptoKeys.KeyInput, signature: CryptoKeys.Input, encoding?: string): boolean {
        return verify(
          this.algorithm,
          this.finalize(),
          key,
          inputBytes(signature, encoding),
        );
      }
    }
    function pbkdf2Sync(password: CryptoKeys.Input, salt: CryptoKeys.Input, iterations: number, keylen: number, digest: string): CryptoKeys.Buffer {
      const key = c.importKey("raw", inputBytes(password), "PBKDF2", false, [
        "deriveBits",
      ]);
      return Buffer.from(
        c.deriveBits(
          {
            name: "PBKDF2",
            hash: hash(digest),
            salt: inputBytes(salt),
            iterations,
          },
          key,
          keylen * 8,
        ),
      );
    }
    function hkdfSync(digest: string, ikm: CryptoKeys.Input | KeyObject, salt: CryptoKeys.Input, info: CryptoKeys.Input, keylen: number): ArrayBuffer {
      const key = c.importKey(
        "raw",
        ikm instanceof KeyObject
          ? c.decode(nodeRecord(ikm).key.k)
          : inputBytes(ikm),
        "HKDF",
        false,
        ["deriveBits"],
      );
      return c.deriveBits(
        {
          name: "HKDF",
          hash: hash(digest),
          salt: inputBytes(salt),
          info: inputBytes(info),
        },
        key,
        keylen * 8,
      );
    }
    function callbackVersion<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: [...Args, callback: (error: Error | null, value: Result) => unknown]) => void;
    function callbackVersion(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => void {
      return (...args) => {
        const callback = args.pop();
        if (typeof callback !== "function")
          throw error("Callback must be a function");
        internal.realTimers.setImmediate(() => {
          let value;
          try {
            value = fn(...args);
          } catch (e) {
            callback(e as Error);
            return;
          }
          callback(null, value);
        });
      };
    }
    return {
      KeyObject,
      createSecretKey,
      createPrivateKey,
      createPublicKey,
      generateKeySync,
      generateKey,
      generateKeyPairSync,
      generateKeyPair,
      publicEncrypt: (key: CryptoKeys.KeyInput, data: CryptoKeys.Input) => rsaCrypt(false, key, data),
      privateDecrypt: (key: CryptoKeys.KeyInput, data: CryptoKeys.Input) => rsaCrypt(true, key, data),
      sign,
      verify,
      Sign,
      Verify,
      createSign: (a: string, o?: unknown) => new Sign(a, o),
      createVerify: (a: string, o?: unknown) => new Verify(a, o),
      constants,
      pbkdf2Sync,
      pbkdf2: callbackVersion(pbkdf2Sync),
      hkdfSync,
      hkdf: callbackVersion(hkdfSync),
      getCurves: () => ["prime256v1", "secp384r1"],
    };
  };
});
