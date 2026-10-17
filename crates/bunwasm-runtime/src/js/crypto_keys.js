(function (internal) {
  "use strict";
  return (Buffer, inputBytes, timingSafeEqual) => {
    const c = internal.crypto;
    const records = new WeakMap();
    internal.nodeCryptoIsKeyObject = (value) => records.has(value);
    const constants = {
      RSA_PKCS1_PADDING: 1,
      RSA_NO_PADDING: 3,
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PSS_PADDING: 6,
      RSA_PSS_SALTLEN_DIGEST: -1,
      RSA_PSS_SALTLEN_AUTO: -2,
      RSA_PSS_SALTLEN_MAX_SIGN: -2,
    };
    const error = (message) =>
      Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
    const family = (a) =>
      a.name.startsWith("RSA")
        ? "rsa"
        : a.name === "ECDSA"
          ? "ec"
          : a.name.toLowerCase();
    const hash = (name) => {
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
    function nodeRecord(key) {
      const r = records.get(key);
      if (!r) throw error("Expected a KeyObject");
      return r;
    }
    function fromCrypto(key) {
      const r = c.record(key);
      return make({ ...r, algorithm: r.algorithm, key: r.key });
    }
    function make(r) {
      const key = Object.create(KeyObject.prototype);
      const algorithm =
        r.key.kty === "RSA"
          ? { ...r.algorithm, name: "RSASSA-PKCS1-v1_5" }
          : r.key.kty === "EC"
            ? { name: "ECDSA", namedCurve: r.algorithm.namedCurve }
            : r.algorithm;
      records.set(key, { ...r, algorithm });
      return key;
    }
    function equalityBytes(key) {
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
      static from(key) {
        return fromCrypto(key);
      }
      get type() {
        return nodeRecord(this).type;
      }
      get symmetricKeySize() {
        const r = nodeRecord(this);
        return r.type === "secret" ? c.decode(r.key.k).length : undefined;
      }
      get asymmetricKeyType() {
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
            publicExponent: a.publicExponent.reduce(
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
      export(options) {
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
            typeof options.cipher !== "string" ||
            options.passphrase === undefined
          )
            throw Object.assign(
              new TypeError(
                `The property 'options.cipher' is invalid. Received ${String(options.cipher)}`,
              ),
              { code: "ERR_INVALID_ARG_VALUE" },
            );
          const mode =
            format === "der"
              ? type === "pkcs8"
                ? 3
                : undefined
              : { pkcs8: 2, pkcs1: 4, sec1: 5 }[type];
          if (mode === undefined)
            throw Object.assign(
              new TypeError("Key encoding does not support encryption"),
              { code: "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS" },
            );
          const encoded = keyEncoding(
            mode,
            c.exportKey("pkcs8", key),
            options.passphrase,
            options.cipher,
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
          .match(/.{1,64}/g)
          .join("\n");
        return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----\n`;
      }
      equals(other) {
        if (!records.has(other))
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
          bBytes = equalityBytes(other);
        return (
          aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes)
        );
      }
      toCryptoKey(algorithm, extractable, keyUsages) {
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
        const sameAlgorithm = ["name", "namedCurve", "length", "modulusLength"]
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
    function privateUsages(a) {
      return ["ECDH", "X25519"].includes(a.name)
        ? ["deriveBits"]
        : a.name === "RSA-OAEP"
          ? ["decrypt"]
          : ["sign"];
    }
    function publicUsages(a) {
      return ["ECDH", "X25519"].includes(a.name)
        ? []
        : a.name === "RSA-OAEP"
          ? ["encrypt"]
          : ["verify"];
    }
    function createSecretKey(key, encoding) {
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
    function parseInput(input) {
      if (
        input &&
        typeof input === "object" &&
        !(input instanceof KeyObject) &&
        !ArrayBuffer.isView(input) &&
        !(input instanceof ArrayBuffer) &&
        !c.isKey(input)
      ) {
        return { ...input };
      }
      return { key: input };
    }
    function keyEncoding(mode, data, password, cipher = "") {
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
    function readPem(key, password) {
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
    function importAsymmetric(input, wantPrivate) {
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
      let format = options.type || (wantPrivate ? "pkcs8" : "spki"),
        bytes,
        isPrivateEncoding = wantPrivate;
      if (jwk) bytes = key;
      else if (typeof key === "string" || options.format !== "der") {
        const decoded = readPem(key, options.passphrase);
        format = decoded.format;
        bytes = decoded.bytes;
        isPrivateEncoding = decoded.private;
      } else {
        bytes = inputBytes(key);
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
          }).key;
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
    function publicPart(r) {
      const key = { ...r.key };
      for (const name of ["d", "p", "q", "dp", "dq", "qi"]) delete key[name];
      return make({ ...r, type: "public", key });
    }
    function createPrivateKey(input) {
      const options = parseInput(input);
      if (options.key instanceof KeyObject || c.isKey(options.key))
        throw error("The key argument must be encoded key data");
      return importAsymmetric(options, true);
    }
    function createPublicKey(input) {
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
    function generateKeySync(type, options) {
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
    function generateKey(type, options, callback) {
      if (typeof callback !== "function")
        throw error("Callback must be a function");
      internal.realTimers.setImmediate(() => {
        let key;
        try {
          key = generateKeySync(type, options);
        } catch (e) {
          callback(e);
          return;
        }
        callback(null, key);
      });
    }
    function generateKeyPairSync(type, options = {}) {
      let a;
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
            { prime256v1: "P-256", secp256r1: "P-256", secp384r1: "P-384" }[
              options.namedCurve
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
    function generateKeyPair(type, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (typeof callback !== "function")
        throw error("Callback must be a function");
      internal.realTimers.setImmediate(() => {
        let pair;
        try {
          pair = generateKeyPairSync(type, options);
        } catch (e) {
          callback(e);
          return;
        }
        callback(null, pair.publicKey, pair.privateKey);
      });
    }
    function signVerify(verify, digest, data, input, signature) {
      const options = parseInput(input);
      const key = importAsymmetric(options, !verify);
      const r = nodeRecord(key),
        a = { ...r.algorithm };
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
        ...(verify ? { signature: c.encode(inputBytes(signature)) } : {}),
      });
      return verify ? result.verified : Buffer.from(c.decode(result.data));
    }
    function rsaCrypt(decrypt, inputKey, data) {
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
    function sign(algorithm, data, key, callback) {
      if (typeof callback !== "function")
        return signVerify(false, algorithm, data, key);
      internal.realTimers.setImmediate(() => {
        let value;
        try {
          value = signVerify(false, algorithm, data, key);
        } catch (e) {
          callback(e);
          return;
        }
        callback(null, value);
      });
    }
    function verify(algorithm, data, key, signature, callback) {
      if (typeof callback !== "function")
        return signVerify(true, algorithm, data, key, signature);
      internal.realTimers.setImmediate(() => {
        let value;
        try {
          value = signVerify(true, algorithm, data, key, signature);
        } catch (e) {
          callback(e);
          return;
        }
        callback(null, value);
      });
    }
    const { Writable } = internal.builtin("node:stream");
    class Sign extends Writable {
      #chunks = [];
      constructor(algorithm, options) {
        super(options);
        this.algorithm = hash(algorithm);
      }
      update(data, encoding) {
        if (this.#chunks === null)
          throw Object.assign(new Error("Not initialised"), {
            code: "ERR_CRYPTO_INVALID_STATE",
          });
        this.#chunks.push(Buffer.from(inputBytes(data, encoding)));
        return this;
      }
      _write(data, encoding, callback) {
        try {
          this.update(data, encoding);
        } catch (e) {
          callback(e);
          return;
        }
        callback();
      }
      finalize() {
        if (this.#chunks === null)
          throw Object.assign(new Error("Not initialised"), {
            code: "ERR_CRYPTO_INVALID_STATE",
          });
        const data = Buffer.concat(this.#chunks);
        this.#chunks = null;
        return data;
      }
      sign(key, encoding) {
        const result = sign(this.algorithm, this.finalize(), key);
        return encoding ? result.toString(encoding) : result;
      }
    }
    class Verify extends Sign {
      verify(key, signature, encoding) {
        return verify(
          this.algorithm,
          this.finalize(),
          key,
          inputBytes(signature, encoding),
        );
      }
    }
    function pbkdf2Sync(password, salt, iterations, keylen, digest) {
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
    function hkdfSync(digest, ikm, salt, info, keylen) {
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
    function callbackVersion(fn) {
      return (...args) => {
        const callback = args.pop();
        if (typeof callback !== "function")
          throw error("Callback must be a function");
        internal.realTimers.setImmediate(() => {
          let value;
          try {
            value = fn(...args);
          } catch (e) {
            callback(e);
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
      publicEncrypt: (key, data) => rsaCrypt(false, key, data),
      privateDecrypt: (key, data) => rsaCrypt(true, key, data),
      sign,
      verify,
      Sign,
      Verify,
      createSign: (a, o) => new Sign(a, o),
      createVerify: (a, o) => new Verify(a, o),
      constants,
      pbkdf2Sync,
      pbkdf2: callbackVersion(pbkdf2Sync),
      hkdfSync,
      hkdf: callbackVersion(hkdfSync),
      getCurves: () => ["prime256v1", "secp384r1"],
    };
  };
});
