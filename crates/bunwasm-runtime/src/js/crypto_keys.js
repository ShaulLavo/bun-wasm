(function (internal) {
  "use strict";
  return (Buffer, inputBytes, timingSafeEqual) => {
    const c = internal.crypto;
    const records = new WeakMap();
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
            publicExponent: Array.from(a.publicExponent).reduce(
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
        if (options?.cipher !== undefined || options?.passphrase !== undefined)
          throw Object.assign(
            new Error("Encrypted key export is not supported"),
            { code: "ERR_NOT_SUPPORTED_IN_WASM" },
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
        const r = nodeRecord(this),
          b = nodeRecord(other);
        if (r.type !== b.type) return false;
        const aBytes = Buffer.from(JSON.stringify(r.key)),
          bBytes = Buffer.from(JSON.stringify(b.key));
        return (
          aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes)
        );
      }
      toCryptoKey(algorithm, extractable, keyUsages) {
        const r = nodeRecord(this);
        return c.importKey(
          "jwk",
          { ...r.key },
          algorithm,
          extractable,
          keyUsages,
        );
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
        !(input instanceof CryptoKey)
      ) {
        return { ...input };
      }
      return { key: input };
    }
    function importAsymmetric(input, wantPrivate) {
      const options = parseInput(input),
        key = options.key;
      if (key instanceof KeyObject || key instanceof CryptoKey) {
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
        const pem = typeof key === "string" ? key : Buffer.from(key).toString();
        const match =
          /-----BEGIN (RSA PRIVATE KEY|RSA PUBLIC KEY|EC PRIVATE KEY|PRIVATE KEY|PUBLIC KEY)-----([\s\S]*?)-----END \1-----/.exec(
            pem,
          );
        if (!match) throw error("Invalid PEM key");
        format =
          match[1] === "RSA PRIVATE KEY" || match[1] === "RSA PUBLIC KEY"
            ? "pkcs1"
            : match[1] === "EC PRIVATE KEY"
              ? "sec1"
              : match[1] === "PRIVATE KEY"
                ? "pkcs8"
                : "spki";
        isPrivateEncoding = match[1].endsWith("PRIVATE KEY");
        bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      } else bytes = inputBytes(key);
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
    const createPrivateKey = (input) => importAsymmetric(input, true);
    const createPublicKey = (input) => importAsymmetric(input, false);
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
      setImmediate(() => {
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
      const key = verify ? createPublicKey(options) : createPrivateKey(options);
      const r = nodeRecord(key),
        a = { ...r.algorithm };
      if (a.name === "X25519") throw error("Key cannot sign");
      if (a.name === "Ed25519" && digest != null)
        throw Object.assign(new Error("Ed25519 does not accept a digest"), {
          code: "ERR_OSSL_EVP_COMMAND_NOT_SUPPORTED",
        });
      if (a.name !== "Ed25519") a.hash = { name: hash(digest) };
      if (family(a) === "rsa") {
        a.name =
          options.padding === constants.RSA_PKCS1_PSS_PADDING
            ? "RSA-PSS"
            : "RSASSA-PKCS1-v1_5";
        a.saltLength = options.saltLength ?? -2;
      }
      a.der = options.dsaEncoding !== "ieee-p1363";
      const result = c.backend(verify ? "verify" : "sign", a, {
        key: r.key,
        data: c.encode(inputBytes(data)),
        ...(verify ? { signature: c.encode(inputBytes(signature)) } : {}),
      });
      return verify ? result.verified : Buffer.from(c.decode(result.data));
    }
    function sign(algorithm, data, key, callback) {
      if (typeof callback !== "function")
        return signVerify(false, algorithm, data, key);
      setImmediate(() => {
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
      setImmediate(() => {
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
      constructor(algorithm, options) {
        super(options);
        this.algorithm = hash(algorithm);
        this.chunks = [];
        this.finalized = false;
      }
      update(data, encoding) {
        if (this.finalized)
          throw Object.assign(new Error("Not initialised"), {
            code: "ERR_CRYPTO_INVALID_STATE",
          });
        this.chunks.push(Buffer.from(inputBytes(data, encoding)));
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
        if (this.finalized)
          throw Object.assign(new Error("Not initialised"), {
            code: "ERR_CRYPTO_INVALID_STATE",
          });
        this.finalized = true;
        return Buffer.concat(this.chunks);
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
        setImmediate(() => {
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
      generateKeyPairSync,
      generateKeyPair,
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
