(function (internal) {
  "use strict";
  const native = internal.native;
  const material = new WeakMap();
  const names = [
    "HMAC",
    "AES-GCM",
    "AES-CBC",
    "AES-CTR",
    "AES-KW",
    "RSA-OAEP",
    "RSASSA-PKCS1-v1_5",
    "RSA-PSS",
    "ECDSA",
    "ECDH",
    "Ed25519",
    "X25519",
    "PBKDF2",
    "HKDF",
  ];
  const hashes = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
  const sizes = {
    "SHA-1": 160,
    "SHA-256": 256,
    "SHA-384": 384,
    "SHA-512": 512,
  };
  const allowed = {
    HMAC: ["sign", "verify"],
    ECDSA: ["sign", "verify"],
    Ed25519: ["sign", "verify"],
    "RSASSA-PKCS1-v1_5": ["sign", "verify"],
    "RSA-PSS": ["sign", "verify"],
    "RSA-OAEP": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
    "AES-KW": ["wrapKey", "unwrapKey"],
    "AES-GCM": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
    "AES-CBC": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
    "AES-CTR": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
    PBKDF2: ["deriveKey", "deriveBits"],
    HKDF: ["deriveKey", "deriveBits"],
    ECDH: ["deriveKey", "deriveBits"],
    X25519: ["deriveKey", "deriveBits"],
  };
  const fail = (name, message) => {
    throw new DOMException(message || name, name);
  };
  const copy = (a) => {
    const out = { ...a };
    if (a.hash) out.hash = { ...a.hash };
    if (a.publicExponent) out.publicExponent = a.publicExponent.slice();
    return out;
  };
  function buffer(data) {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
      throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
    if (data.byteLength > 0x7fffffff)
      fail("OperationError", "Crypto input is too large");
    return internal.toUint8(data).slice();
  }
  const encode = (data) => native.base64Encode(buffer(data), true);
  const decode = (data) => native.base64Decode(data);
  function algorithm(value, digest = false) {
    const a = typeof value === "string" ? { name: value } : { ...value };
    if (typeof a.name !== "string")
      throw new TypeError("Algorithm name is required");
    const name = (digest ? hashes : names).find(
      (n) => n.toUpperCase() === a.name.toUpperCase(),
    );
    if (!name) fail("NotSupportedError", `Unrecognized algorithm ${a.name}`);
    a.name = name;
    if (a.hash !== undefined) a.hash = algorithm(a.hash, true);
    return a;
  }
  function requiredHash(a) {
    if (!a.hash) throw new TypeError("Algorithm hash is required");
    return a.hash;
  }
  function integer(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max)
      fail("OperationError", `Invalid ${name}`);
    return value;
  }
  function usagesFor(a, type) {
    if (type === "secret") return allowed[a.name];
    if (type === "private")
      return allowed[a.name].filter((u) =>
        ["sign", "decrypt", "unwrapKey", "deriveKey", "deriveBits"].includes(u),
      );
    return allowed[a.name].filter((u) =>
      ["verify", "encrypt", "wrapKey"].includes(u),
    );
  }
  function checkUsages(a, type, usages) {
    const legal = usagesFor(a, type);
    if (usages.some((u) => !legal.includes(u)))
      fail("SyntaxError", "Unsupported key usage");
    if (type !== "public" && usages.length === 0)
      fail("SyntaxError", "Key usages must not be empty");
  }
  class CryptoKey {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
    get type() {
      return record(this).type;
    }
    get extractable() {
      return record(this).extractable;
    }
    get algorithm() {
      return record(this).displayAlgorithm;
    }
    get usages() {
      return record(this).usages.slice();
    }
    get [Symbol.toStringTag]() {
      return "CryptoKey";
    }
  }
  function record(key) {
    const r = material.get(key);
    if (!r) throw new TypeError("Expected a CryptoKey");
    return r;
  }
  function makeKey(a, type, extractable, usages, key) {
    checkUsages(a, type, usages);
    const out = Object.create(CryptoKey.prototype);
    material.set(out, {
      algorithm: copy(a),
      displayAlgorithm: copy(a),
      type,
      extractable: !!extractable,
      usages: usages.slice(),
      key,
    });
    return out;
  }
  function use(key, a, usage) {
    if (!allowed[a.name].includes(usage))
      fail("NotSupportedError", "Algorithm does not support this operation");
    const r = record(key);
    if (r.algorithm.name !== a.name || !r.usages.includes(usage))
      fail("InvalidAccessError", "Key does not support this operation");
    return r;
  }
  function backend(op, a, extra = {}) {
    const flat = { ...a };
    if (flat.hash) flat.hash = flat.hash.name;
    const result = JSON.parse(
      native.cryptoOp(JSON.stringify({ op, algorithm: flat, ...extra })),
    );
    if (result.error) fail(result.error, `Crypto ${op} failed`);
    return result;
  }
  function keyAlgorithm(a, k) {
    if (k.kty === "oct") return { ...a, length: decode(k.k).length * 8 };
    if (k.kty === "RSA") {
      const n = decode(k.n);
      return {
        name: a.name,
        hash: requiredHash(a),
        modulusLength: (n.length - 1) * 8 + 32 - Math.clz32(n[0]),
        publicExponent: decode(k.e),
      };
    }
    if (k.kty === "EC") return { name: a.name, namedCurve: a.namedCurve };
    return { name: a.name };
  }
  function publicUsages(a, usages, type) {
    return usages.filter((u) => usagesFor(a, type).includes(u));
  }
  function generate(a, extractable, usages) {
    a = algorithm(a);
    usages = Array.from(new Set(usages));
    if (a.name === "HMAC") requiredHash(a);
    if (a.name.startsWith("AES-") || a.name === "HMAC") {
      const length =
        a.name === "HMAC"
          ? (a.length ??
            (requiredHash(a).name === "SHA-384" || a.hash.name === "SHA-512"
              ? 1024
              : 512))
          : a.length;
      integer(length, 1, 0x7fffffff, "key length");
      if (a.name.startsWith("AES-") && ![128, 192, 256].includes(length))
        fail("OperationError", "AES key length must be 128, 192, or 256");
      const raw = native.randomBytes(Math.ceil(length / 8));
      if (length % 8) raw[raw.length - 1] &= 0xff << (8 - (length % 8));
      return makeKey({ ...a, length }, "secret", extractable, usages, {
        kty: "oct",
        k: native.base64Encode(raw, true),
      });
    }
    if (["PBKDF2", "HKDF"].includes(a.name)) fail("NotSupportedError");
    if (usages.some((u) => !allowed[a.name].includes(u)))
      fail("SyntaxError", "Unsupported key usage");
    if (a.name.startsWith("RSA") || a.name === "RSASSA-PKCS1-v1_5") {
      requiredHash(a);
      a.publicExponent = encode(a.publicExponent);
    }
    const pair = backend("generate", a);
    const descriptor = keyAlgorithm(a, pair.privateKey);
    return {
      privateKey: makeKey(
        descriptor,
        "private",
        extractable,
        publicUsages(a, usages, "private"),
        pair.privateKey,
      ),
      publicKey: makeKey(
        descriptor,
        "public",
        true,
        publicUsages(a, usages, "public"),
        pair.publicKey,
      ),
    };
  }
  function jwkAlg(a) {
    const suffix = a.hash?.name === "SHA-1" ? 1 : sizes[a.hash?.name];
    if (a.name === "HMAC") return `HS${suffix}`;
    if (a.name === "RSA-PSS") return `PS${suffix}`;
    if (a.name === "RSASSA-PKCS1-v1_5") return `RS${suffix}`;
    if (a.name === "RSA-OAEP")
      return a.hash.name === "SHA-1"
        ? "RSA-OAEP"
        : `RSA-OAEP-${sizes[a.hash.name]}`;
    if (a.name.startsWith("AES-")) return `A${a.length}${a.name.slice(4)}`;
    if (a.name === "Ed25519") return "EdDSA";
    return undefined;
  }
  function validateJwkOctets(k) {
    for (const field of [
      "k",
      "n",
      "e",
      "d",
      "p",
      "q",
      "dp",
      "dq",
      "qi",
      "x",
      "y",
    ]) {
      if (
        k[field] !== undefined &&
        (typeof k[field] !== "string" ||
          !/^[A-Za-z0-9_-]*$/.test(k[field]) ||
          k[field].length % 4 === 1)
      )
        fail("DataError", "Invalid JWK octets");
    }
  }
  function validateJwk(k, a, extractable, usages) {
    if (!k || typeof k !== "object" || Array.isArray(k))
      fail("DataError", "Invalid JWK");
    const secret =
      ["HMAC", "PBKDF2", "HKDF"].includes(a.name) || a.name.startsWith("AES-");
    const kty = secret
      ? "oct"
      : a.name.startsWith("RSA")
        ? "RSA"
        : ["ECDSA", "ECDH"].includes(a.name)
          ? "EC"
          : "OKP";
    validateJwkOctets(k);
    const fields =
      kty === "oct"
        ? ["k"]
        : kty === "RSA"
          ? ["n", "e"].concat(
              k.d !== undefined ? ["d", "p", "q", "dp", "dq", "qi"] : [],
            )
          : (kty === "EC" ? ["x", "y"] : ["x"]).concat(
              k.d !== undefined ? ["d"] : [],
            );
    if (fields.some((field) => typeof k[field] !== "string"))
      fail("DataError", "Missing JWK key material");
    if (k.oth !== undefined)
      fail("NotSupportedError", "Multi-prime RSA keys are not supported");
    if (k.kty !== kty || (kty === "EC" && k.crv !== a.namedCurve))
      fail("DataError", "JWK key type or curve does not match");
    if (k.ext !== undefined && !k.ext && extractable)
      fail("DataError", "JWK key is not extractable");
    if (
      k.key_ops !== undefined &&
      (!Array.isArray(k.key_ops) ||
        new Set(k.key_ops).size !== k.key_ops.length ||
        usages.some((u) => !k.key_ops.includes(u)))
    )
      fail("DataError", "Invalid JWK key_ops");
    if (
      k.use !== undefined &&
      usages.length &&
      k.use !== (["sign", "verify"].includes(usages[0]) ? "sig" : "enc")
    )
      fail("DataError", "Invalid JWK use");
    const expected =
      a.name === "ECDSA"
        ? { "P-256": "ES256", "P-384": "ES384" }[a.namedCurve]
        : jwkAlg(
            secret
              ? {
                  ...a,
                  length: typeof k.k === "string" ? decode(k.k).length * 8 : 0,
                }
              : a,
          );
    const matchesAlgorithm =
      k.alg === expected || (a.name === "Ed25519" && k.alg === "Ed25519");
    if (k.alg !== undefined && expected !== undefined && !matchesAlgorithm)
      fail("DataError", "JWK algorithm does not match");
  }
  function importKey(format, data, a, extractable, usages) {
    a = algorithm(a);
    format = String(format);
    usages = Array.from(new Set(usages));
    if (!["raw", "jwk", "spki", "pkcs8"].includes(format))
      throw new TypeError("Invalid key format");
    if (a.name === "HMAC" || a.name.startsWith("RSA")) requiredHash(a);
    if (format === "jwk") validateJwk(data, a, extractable, usages);
    const secret =
      a.name === "HMAC" ||
      a.name.startsWith("AES-") ||
      ["PBKDF2", "HKDF"].includes(a.name);
    if (secret) return importSecret(format, data, a, extractable, usages);
    const input =
      format === "jwk" ? native.utf8Encode(JSON.stringify(data)) : buffer(data);
    const k = backend("import", a, {
      format,
      data: native.base64Encode(input, true),
    }).key;
    const type = k.d ? "private" : "public";
    if (
      (format === "pkcs8" && type !== "private") ||
      (format === "spki" && type !== "public")
    )
      fail("DataError");
    return makeKey(keyAlgorithm(a, k), type, extractable, usages, k);
  }
  function importSecret(format, data, a, extractable, usages) {
    if (!["jwk", "raw"].includes(format)) fail("NotSupportedError");
    if (
      ["PBKDF2", "HKDF"].includes(a.name) &&
      (format !== "raw" || extractable)
    )
      fail("SyntaxError", "Derivation keys cannot be extractable");
    if (format === "jwk" && typeof data.k !== "string")
      fail("DataError", "Missing JWK k");
    const raw = format === "jwk" ? decode(data.k) : buffer(data);
    let length = raw.length * 8;
    if (a.name.startsWith("AES-") && ![128, 192, 256].includes(length))
      fail("DataError", "Invalid AES key length");
    if (a.name === "HMAC") {
      if (
        !length ||
        (a.length !== undefined &&
          (a.length <= length - 8 || a.length > length || a.length <= 0))
      )
        fail("DataError", "Invalid HMAC key length");
      length = a.length ?? length;
    }
    return makeKey(
      a.name.startsWith("AES-") || a.name === "HMAC"
        ? { ...a, length }
        : { name: a.name },
      "secret",
      extractable,
      usages,
      { kty: "oct", k: native.base64Encode(raw, true) },
    );
  }
  function exportKey(format, key) {
    format = String(format);
    const r = record(key);
    if (!r.extractable) fail("InvalidAccessError", "Key is not extractable");
    if (format === "jwk") {
      const k = { ...r.key, key_ops: r.usages.slice(), ext: r.extractable };
      const alg = jwkAlg(r.algorithm);
      if (alg !== undefined) k.alg = alg;
      return k;
    }
    if (format === "raw" && r.type === "secret") return decode(r.key.k).buffer;
    if (
      (format === "pkcs8" && r.type !== "private") ||
      (format === "spki" && r.type !== "public") ||
      (format === "raw" && r.type !== "public")
    )
      fail("InvalidAccessError");
    return decode(backend("export", r.algorithm, { format, key: r.key }).data)
      .buffer;
  }
  function operationAlgorithm(a, r) {
    const out = { ...a };
    if (r.algorithm.hash) out.hash = r.algorithm.hash;
    if (r.algorithm.namedCurve) out.namedCurve = r.algorithm.namedCurve;
    if (a.name === "ECDSA") out.hash = requiredHash(a);
    if (a.name === "RSA-PSS")
      integer(a.saltLength, 0, 0x7fffffff, "saltLength");
    return out;
  }
  function signVerify(op, a, key, data, signature) {
    a = algorithm(a);
    const r = use(key, a, op);
    const result = backend(op, operationAlgorithm(a, r), {
      key: r.key,
      data: encode(data),
      ...(op === "verify" ? { signature: encode(signature) } : {}),
    });
    return op === "verify" ? result.verified : decode(result.data).buffer;
  }
  function crypt(op, a, key, data, usage = op) {
    a = algorithm(a);
    const r = use(key, a, usage);
    const out = operationAlgorithm(a, r);
    if (a.name === "AES-CBC" || a.name === "AES-GCM") out.iv = encode(a.iv);
    if (a.name === "AES-CBC" && buffer(a.iv).length !== 16)
      fail("OperationError", "Invalid IV");
    if (a.name === "AES-GCM") {
      out.additionalData =
        a.additionalData === undefined ? "" : encode(a.additionalData);
      out.tagLength = a.tagLength ?? 128;
      if (![32, 64, 96, 104, 112, 120, 128].includes(out.tagLength))
        fail("OperationError", "Invalid tagLength");
    }
    if (a.name === "AES-CTR") {
      out.counter = encode(a.counter);
      out.length = integer(a.length, 1, 128, "counter length");
    }
    if (a.name === "RSA-OAEP")
      out.label = a.label === undefined ? "" : encode(a.label);
    return decode(backend(op, out, { key: r.key, data: encode(data) }).data)
      .buffer;
  }
  function deriveBits(a, key, length, usage = "deriveBits") {
    a = algorithm(a);
    const r = use(key, a, usage);
    const out = operationAlgorithm(a, r);
    const agreement = a.name === "ECDH" || a.name === "X25519";
    const max =
      a.name === "X25519"
        ? 256
        : r.algorithm.namedCurve === "P-384"
          ? 384
          : 256;
    if (length == null && agreement) length = max;
    integer(length, 0, 0x7fffffff, "derived length");
    if (length % 8)
      fail("OperationError", "Derived length must be a multiple of eight");
    const extra = { key: r.key, length: length / 8 };
    if (agreement) {
      const p = record(a.public);
      if (
        p.type !== "public" ||
        p.algorithm.name !== a.name ||
        p.algorithm.namedCurve !== r.algorithm.namedCurve
      )
        fail("InvalidAccessError");
      extra.public = p.key;
      delete out.public;
    } else {
      requiredHash(a);
      out.hash = a.hash;
      out.salt = encode(a.salt);
      if (a.name === "HKDF") out.info = encode(a.info);
      else out.iterations = integer(a.iterations, 1, 0xffffffff, "iterations");
    }
    return decode(backend("derive", out, extra).data).buffer;
  }
  class SubtleCrypto {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
    async digest(a, data) {
      return native.hash(algorithm(a, true).name, buffer(data)).buffer;
    }
    async generateKey(a, extractable, usages) {
      return generate(a, extractable, usages);
    }
    async importKey(format, data, a, extractable, usages) {
      return importKey(format, data, a, extractable, usages);
    }
    async exportKey(format, key) {
      return exportKey(format, key);
    }
    async sign(a, key, data) {
      return signVerify("sign", a, key, data);
    }
    async verify(a, key, signature, data) {
      return signVerify("verify", a, key, data, signature);
    }
    async encrypt(a, key, data) {
      return crypt("encrypt", a, key, data);
    }
    async decrypt(a, key, data) {
      return crypt("decrypt", a, key, data);
    }
    async deriveBits(a, key, length) {
      return deriveBits(a, key, length);
    }
    async deriveKey(a, key, derived, extractable, usages) {
      derived = algorithm(derived);
      if (derived.name === "HMAC") requiredHash(derived);
      const length =
        derived.length ??
        (derived.name === "HMAC"
          ? requiredHash(derived).name === "SHA-384" ||
            derived.hash.name === "SHA-512"
            ? 1024
            : 512
          : undefined);
      return importKey(
        "raw",
        deriveBits(a, key, length, "deriveKey"),
        derived,
        extractable,
        usages,
      );
    }
    async wrapKey(format, key, wrappingKey, a) {
      const data = exportKey(format, key);
      let bytes =
        format === "jwk" ? native.utf8Encode(JSON.stringify(data)) : data;
      if (format === "jwk" && algorithm(a).name === "AES-KW") {
        const padded = new Uint8Array(Math.ceil(bytes.length / 8) * 8).fill(32);
        padded.set(bytes);
        bytes = padded;
      }
      return crypt("encrypt", a, wrappingKey, bytes, "wrapKey");
    }
    async unwrapKey(format, wrapped, key, a, unwrapped, extractable, usages) {
      const bytes = crypt("decrypt", a, key, wrapped, "unwrapKey");
      if (format !== "jwk")
        return importKey(format, bytes, unwrapped, extractable, usages);
      let jwk;
      try {
        jwk = JSON.parse(native.utf8Decode(new Uint8Array(bytes), true));
      } catch {
        fail("DataError", "Invalid wrapped JWK");
      }
      return importKey(format, jwk, unwrapped, extractable, usages);
    }
    get [Symbol.toStringTag]() {
      return "SubtleCrypto";
    }
  }
  const cryptoObject = globalThis.crypto;
  const subtleInstance = native.subtleCrypto || Object.create(SubtleCrypto.prototype);
  class Crypto {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
    get subtle() {
      if (this !== cryptoObject) throw new TypeError("Illegal invocation");
      return subtleInstance;
    }
    set subtle(_value) {}
    get [Symbol.toStringTag]() {
      return "Crypto";
    }
  }
  internal.crypto = {
    supportsAlgorithm: name => names.some(item => item.toUpperCase() === name.toUpperCase()),
    isKey: (value) => material.has(value),
    isWasmKey: (value) => material.has(value) && !material.get(value).nativeKey,
    rememberKey(key, jwk) {
      const data = { ...jwk };
      for (const field of ["alg", "ext", "key_ops", "use"]) delete data[field];
      material.set(key, {
        algorithm: copy(key.algorithm), displayAlgorithm: key.algorithm,
        type: key.type, extractable: key.extractable, usages: Array.from(key.usages),
        key: data, nativeKey: key,
      });
    },
    record,
    makeKey,
    generate,
    importKey,
    exportKey,
    signVerify,
    crypt,
    deriveBits,
    backend,
    algorithm,
    buffer,
    encode,
    decode,
    keyAlgorithm,
  };
  if (native.subtleCrypto) {
    Object.setPrototypeOf(CryptoKey.prototype, native.CryptoKey.prototype);
    internal.require("crypto_host_keys");
  }
  return (defineGlobal) => {
    defineGlobal("Crypto", Crypto);
    Object.setPrototypeOf(globalThis.crypto, Crypto.prototype);
    defineGlobal("CryptoKey", native.subtleCrypto ? native.CryptoKey : CryptoKey);
    defineGlobal("SubtleCrypto", native.subtleCrypto ? native.SubtleCrypto : SubtleCrypto);
  };
});
