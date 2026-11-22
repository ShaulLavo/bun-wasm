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
    "ChaCha20-Poly1305",
    "ML-DSA-44",
    "ML-DSA-65",
    "ML-DSA-87",
    "ML-KEM-768",
    "ML-KEM-1024",
  ];
  const hashes = ["SHA-1", "SHA-256", "SHA-384", "SHA-512", "SHA3-256", "SHA3-384", "SHA3-512"];
  // An HMAC key's default length is its hash's block size, in bits.
  const blockBits = { "SHA-1": 512, "SHA-256": 512, "SHA-384": 1024, "SHA-512": 1024, "SHA3-256": 1088, "SHA3-384": 832, "SHA3-512": 576 };
  const isAkp = (name) => name.startsWith("ML-");
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
    "ChaCha20-Poly1305": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
    "ML-DSA-44": ["sign", "verify"],
    "ML-DSA-65": ["sign", "verify"],
    "ML-DSA-87": ["sign", "verify"],
    "ML-KEM-768": ["encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits"],
    "ML-KEM-1024": ["encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits"],
  };
  // WebCore's messages for an exception that names no reason of its own.
  const defaultMessages = {
    OperationError: "The operation failed for an operation-specific reason",
    DataError: "Data provided to an operation does not meet requirements",
    InvalidAccessError: "The requested operation is not valid for the provided key",
    NotSupportedError: "The algorithm is not supported",
  };
  const fail = (name, message) => {
    throw new DOMException(message || defaultMessages[name] || name, name);
  };
  // Bun reports usage problems as plain SyntaxErrors, not DOMExceptions.
  const syntax = (message) => {
    throw new SyntaxError(message);
  };
  const typeError = (message, code) => {
    const error = new TypeError(message);
    if (code) error.code = code;
    throw error;
  };
  // WebCrypto's KeyUsage enum order; a key lists its usages in this order, as in Bun.
  const usageOrder = ["encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey"];
  // Bun's KeyUsage enum also spells the KEM usages, which no algorithm here accepts.
  const keyUsages = usageOrder.concat(["encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits"]);
  const keyFormats = ["raw", "raw-public", "raw-secret", "raw-seed", "spki", "pkcs8", "jwk"];
  const rsaNames = ["RSASSA-PKCS1-v1_5", "RSA-PSS", "RSA-OAEP"];
  const enumeration = (value) => {
    const text = String(value);
    if (!keyUsages.includes(text)) typeError("value must be enumeration (string)");
    return text;
  };
  // A sequence<KeyUsage>, duplicates kept.
  function usageSequence(value) {
    if (value === null || typeof value !== "object" || typeof value[Symbol.iterator] !== "function")
      typeError("Value is not a sequence", "ERR_INVALID_ARG_TYPE");
    return Array.from(value, enumeration);
  }
  const usageList = (value) => Array.from(new Set(usageSequence(value)));
  // Converts a KeyFormat argument once, as WebIDL does.
  function keyFormat(value, method) {
    const text = String(value);
    if (!keyFormats.includes(text))
      typeError(`Failed to execute '${method}' on 'SubtleCrypto': 1st argument '${text}' is not a valid enum value of type KeyFormat.`, "ERR_INVALID_ARG_VALUE");
    return text;
  }
  function bufferSource(data, method, position) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data;
    if (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer) return data;
    typeError(`Failed to execute '${method}' on 'SubtleCrypto': ${position} argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView.`, "ERR_INVALID_ARG_TYPE");
  }
  // The JsonWebKey dictionary: each member is read once, in WebIDL's sorted order.
  const jwkMembers = ["alg", "crv", "d", "dp", "dq", "e", "ext", "k", "key_ops", "kty", "n", "oth", "p", "priv", "pub", "q", "qi", "use", "x", "y"];
  function jwkDictionary(value) {
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" && typeof value !== "function") typeError("Type error");
    const out = {};
    for (const member of jwkMembers) {
      const item = value[member];
      if (item === undefined) continue;
      if (member === "ext") out.ext = Boolean(item);
      else if (member === "key_ops") out.key_ops = usageSequence(item);
      else if (member === "oth") out.oth = item;
      else out[member] = String(item);
    }
    return out;
  }
  const copy = (a) => {
    const out = { ...a };
    if (a.hash) out.hash = { ...a.hash };
    if (a.publicExponent) out.publicExponent = a.publicExponent.slice();
    return out;
  };
  function buffer(data) {
    return view(data).slice();
  }
  // The caller's bytes, checked but not copied: for a consumer that copies or reads them now.
  function view(data) {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
      throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
    if (data.byteLength > 0x7fffffff)
      fail("OperationError", "Crypto input is too large");
    return internal.toUint8(data);
  }
  const encode = (data) => native.base64Encode(buffer(data), true);
  const decode = (data) => native.base64Decode(data);
  function algorithm(value, digest = false) {
    const object = value !== null && (typeof value === "object" || typeof value === "function");
    const a = object ? { ...value } : { name: String(value) };
    if (object && value.name === undefined)
      typeError("Member CryptoAlgorithmParameters.name is required and must be an instance of DOMString", "ERR_MISSING_OPTION");
    a.name = String(a.name);
    if (!digest && a.name.toUpperCase() === "RSAES-PKCS1-V1_5") fail("NotSupportedError", "RSAES-PKCS1-v1_5 support is deprecated");
    const name = (digest ? hashes : names).find(
      (n) => n.toUpperCase() === a.name.toUpperCase(),
    );
    if (!name) fail("NotSupportedError", "Unrecognized algorithm name");
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
        ["sign", "decrypt", "unwrapKey", "deriveKey", "deriveBits", "decapsulateKey", "decapsulateBits"].includes(u),
      );
    return allowed[a.name].filter((u) =>
      ["verify", "encrypt", "wrapKey", "encapsulateKey", "encapsulateBits"].includes(u),
    );
  }
  // Bun's wording differs between generateKey (creating) and importKey.
  function usageMessage(a, creating) {
    if (a.name.startsWith("AES-")) return "Unsupported key usage for an AES key";
    if (a.name === "ChaCha20-Poly1305") return "Unsupported key usage for a ChaCha20-Poly1305 key";
    if (isAkp(a.name)) return `Unsupported key usage for ${creating ? "an" : "a"} ${a.name} key`;
    if (a.name === "HMAC") return creating ? "Unsupported key usage for an HMAC key" : "Unsupported key usage for HMAC key";
    if (creating) return rsaNames.includes(a.name) ? "Unsupported key usage for a RSA key" : "A required parameter was missing or out-of-range";
    if (a.name === "PBKDF2" || a.name === "HKDF") return `Unsupported key usage for a ${a.name} key`;
    return `Unsupported key usage for an ${a.name} key`;
  }
  function emptyUsages(type, creating) {
    syntax(creating ? "Usages cannot be empty when creating a key." : `Usages cannot be empty when importing a ${type} key.`);
  }
  function checkUsages(a, type, usages, creating = false) {
    const legal = usagesFor(a, type);
    if (usages.some((u) => !legal.includes(u))) syntax(usageMessage(a, creating));
    if (type !== "public" && usages.length === 0) emptyUsages(type, creating);
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
  function makeKey(a, type, extractable, usages, key, creating = false) {
    checkUsages(a, type, usages, creating);
    const out = Object.create(CryptoKey.prototype);
    material.set(out, {
      algorithm: copy(a),
      displayAlgorithm: copy(a),
      type,
      extractable: !!extractable,
      usages: keyUsages.filter((usage) => usages.includes(usage)),
      key,
    });
    return out;
  }
  // structuredClone of a CryptoKey: a new key over a copy of the same record.
  function cloneKey(key) {
    const r = record(key);
    const out = Object.create(CryptoKey.prototype);
    material.set(out, { ...r, algorithm: copy(r.algorithm), displayAlgorithm: copy(r.displayAlgorithm), usages: r.usages.slice(), key: { ...r.key } });
    return out;
  }
  // postMessage: a key the wasm provider owns travels as its record in JSON, and the
  // receiving realm rebuilds a key over the same material, as Bun's serializer does.
  const exponentOut = (a) => (a.publicExponent ? { ...a, publicExponent: encode(a.publicExponent) } : { ...a });
  const exponentIn = (a) => (typeof a.publicExponent === "string" ? { ...a, publicExponent: decode(a.publicExponent) } : { ...a });
  function serializeKey(value) {
    const r = material.get(value);
    if (!r) return undefined;
    return JSON.stringify({
      algorithm: exponentOut(r.algorithm),
      displayAlgorithm: exponentOut(r.displayAlgorithm),
      type: r.type,
      extractable: r.extractable,
      usages: r.usages,
      key: r.key,
    });
  }
  function deserializeKey(text) {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    const valid =
      data !== null &&
      typeof data === "object" &&
      names.includes(data.algorithm?.name) &&
      data.displayAlgorithm?.name === data.algorithm.name &&
      ["secret", "public", "private"].includes(data.type) &&
      typeof data.extractable === "boolean" &&
      Array.isArray(data.usages) &&
      data.usages.every((usage) => keyUsages.includes(usage)) &&
      data.key !== null &&
      typeof data.key === "object";
    if (!valid) fail("DataCloneError", "The object cannot be cloned");
    const out = Object.create(CryptoKey.prototype);
    material.set(out, {
      algorithm: exponentIn(data.algorithm),
      displayAlgorithm: exponentIn(data.displayAlgorithm),
      type: data.type,
      extractable: data.extractable,
      usages: data.usages,
      key: data.key,
    });
    return out;
  }
  function use(key, a, usage) {
    if (!allowed[a.name].includes(usage))
      fail("NotSupportedError", "Algorithm does not support this operation");
    const r = record(key);
    if (r.algorithm.name !== a.name) fail("InvalidAccessError", "Key algorithm mismatch");
    if (!r.usages.includes(usage)) fail("InvalidAccessError", `Unable to use this key to ${usage}`);
    return r;
  }
  // The native side answers an error name, or "Name: message" when Bun names a reason.
  const backendMessages = { import: { DataError: "Invalid keyData" } };
  function backend(op, a, extra = {}) {
    const flat = { ...a };
    if (flat.hash) flat.hash = flat.hash.name;
    const result = JSON.parse(
      native.cryptoOp(JSON.stringify({ op, algorithm: flat, ...extra })),
    );
    if (!result.error) return result;
    const at = result.error.indexOf(": ");
    if (at >= 0) fail(result.error.slice(0, at), result.error.slice(at + 2));
    fail(result.error, backendMessages[op]?.[result.error]);
  }
  function keyAlgorithm(a, k) {
    if (k.kty === "oct") return { ...a, length: decode(k.k).length * 8 };
    if (k.kty === "RSA") {
      const n = decode(k.n);
      // Bun's RsaHashedKeyAlgorithm member order.
      const hash = requiredHash(a);
      return {
        name: a.name,
        modulusLength: (n.length - 1) * 8 + 32 - Math.clz32(n[0]),
        publicExponent: decode(k.e),
        hash,
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
    usages = usageList(usages);
    if (a.name === "HMAC") requiredHash(a);
    // A ChaCha20-Poly1305 key is always 256 bits; Bun ignores a length member.
    if (a.name === "ChaCha20-Poly1305")
      return makeKey({ name: a.name }, "secret", extractable, usages, { kty: "oct", k: native.base64Encode(native.randomBytes(32), true) }, true);
    if (a.name.startsWith("AES-") || a.name === "HMAC") {
      const length = a.name === "HMAC" ? (a.length ?? blockBits[requiredHash(a).name]) : a.length;
      integer(length, 1, 0x7fffffff, "key length");
      if (a.name.startsWith("AES-") && ![128, 192, 256].includes(length))
        fail("OperationError", "AES key length must be 128, 192, or 256");
      const raw = native.randomBytes(Math.ceil(length / 8));
      if (length % 8) raw[raw.length - 1] &= 0xff << (8 - (length % 8));
      return makeKey({ ...a, length }, "secret", extractable, usages, {
        kty: "oct",
        k: native.base64Encode(raw, true),
      }, true);
    }
    if (["PBKDF2", "HKDF"].includes(a.name)) fail("NotSupportedError", "Unrecognized algorithm name");
    if (usages.some((u) => !allowed[a.name].includes(u))) syntax(usageMessage(a, true));
    // Checked before the (slow) key generation, as in Bun.
    if (publicUsages(a, usages, "private").length === 0) emptyUsages("private", true);
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
    if (a.name === "ChaCha20-Poly1305") return "C20P";
    if (isAkp(a.name)) return a.name;
    // JOSE names no SHA-3 algorithms, so Bun's JWK has no "alg" for them.
    if (a.hash?.name?.startsWith("SHA3-")) return undefined;
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
  function validateJwkOctets(k, reject) {
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
        reject("Invalid keyData");
    }
  }
  function jwkKeyType(a) {
    if (["HMAC", "PBKDF2", "HKDF", "ChaCha20-Poly1305"].includes(a.name) || a.name.startsWith("AES-")) return "oct";
    if (a.name.startsWith("RSA")) return "RSA";
    if (isAkp(a.name)) return "AKP";
    return ["ECDSA", "ECDH"].includes(a.name) ? "EC" : "OKP";
  }
  // An AKP JWK (ML-DSA, ML-KEM), checked in Node's order with Bun's messages; a missing
  // "alg" and bad key material are "Invalid keyData".
  function validateAkpJwk(k, a, extractable, usages) {
    const reject = (message = "Invalid keyData") => fail("DataError", message);
    if (k.kty !== "AKP") reject('Invalid JWK "kty" Parameter');
    if (k.use !== undefined && usages.length && k.use !== (a.name.startsWith("ML-DSA") ? "sig" : "enc"))
      reject('Invalid JWK "use" Parameter');
    if (k.key_ops !== undefined && new Set(k.key_ops).size !== k.key_ops.length) reject("Duplicate key operation");
    if (k.key_ops !== undefined && usages.some((u) => !k.key_ops.includes(u))) reject("Key operations and usage mismatch");
    if (k.ext !== undefined && !k.ext && extractable) reject('JWK "ext" Parameter and extractable mismatch');
    if (k.alg === undefined) reject();
    if (k.alg !== a.name) reject('JWK "alg" Parameter and algorithm name mismatch');
    for (const field of ["pub", "priv"]) {
      if (k[field] !== undefined && (typeof k[field] !== "string" || !/^[A-Za-z0-9_-]*$/.test(k[field]))) reject();
    }
    if (typeof k.pub !== "string") reject();
  }
  // HMAC and ChaCha20-Poly1305 report Node's member messages; AES and the KDFs only
  // WebCore's generic DataError. The others name "use", "crv" and "alg" problems and call
  // the rest "Invalid keyData".
  function validateJwk(k, a, extractable, usages) {
    const kty = jwkKeyType(a);
    const isHmac = a.name === "HMAC";
    const hmac = isHmac || a.name === "ChaCha20-Poly1305";
    const generic = kty === "oct" && !hmac;
    const reject = (message) => fail("DataError", generic ? undefined : message);
    if (hmac && k.kty !== undefined && k.kty !== "oct") reject('Invalid JWK "kty" Parameter');
    if (k.kty !== kty) reject("Invalid keyData");
    if (kty === "EC" && k.crv !== a.namedCurve) reject('JWK "crv" does not match the requested algorithm');
    if (kty === "OKP" && k.crv !== a.name) reject('JWK "crv" Parameter and algorithm name mismatch');
    if (k.use !== undefined && usages.length && k.use !== (["sign", "verify"].includes(usages[0]) ? "sig" : "enc"))
      reject('Invalid JWK "use" Parameter');
    if (k.key_ops !== undefined && new Set(k.key_ops).size !== k.key_ops.length)
      reject(hmac ? "Duplicate key operation" : "Invalid keyData");
    if (k.key_ops !== undefined && usages.some((u) => !k.key_ops.includes(u)))
      reject(hmac ? "Key operations and usage mismatch" : "Invalid keyData");
    if (k.ext !== undefined && !k.ext && extractable)
      reject(hmac ? 'JWK "ext" Parameter and extractable mismatch' : "Invalid keyData");
    // Node decodes an HMAC "k" leniently, so a bad one is an empty key.
    if (isHmac && !decodeLenient(k.k ?? "").length) reject("Zero-length key is not supported");
    if (!isHmac) validateJwkOctets(k, reject);
    validateJwkMaterial(k, a, kty, reject);
  }
  function validateJwkMaterial(k, a, kty, reject) {
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
    if (fields.some((field) => typeof k[field] !== "string")) reject("Invalid keyData");
    if (k.oth !== undefined)
      fail("NotSupportedError", "Multi-prime RSA keys are not supported");
    const expected =
      a.name === "ECDSA"
        ? { "P-256": "ES256", "P-384": "ES384", "P-521": "ES512" }[a.namedCurve]
        : jwkAlg(
            kty === "oct"
              ? {
                  ...a,
                  length: typeof k.k === "string" ? decodeLenient(k.k).length * 8 : 0,
                }
              : a,
          );
    const matchesAlgorithm =
      k.alg === expected || (a.name === "Ed25519" && k.alg === "Ed25519");
    if (k.alg !== undefined && expected !== undefined && !matchesAlgorithm)
      reject('JWK "alg" does not match the requested algorithm');
  }
  // Base64 or base64url, ignoring the characters neither alphabet has, as Node's Buffer does.
  function decodeLenient(text) {
    const clean = String(text).replace(/[^A-Za-z0-9+/_-]/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    return decode(clean.length % 4 === 1 ? clean.slice(0, -1) : clean);
  }
  // Arguments convert in WebIDL order: the format once, then the key data by format,
  // then the algorithm and usages. Bun treats raw-public and raw-secret as raw.
  function importKey(format, data, a, extractable, usages) {
    format = keyFormat(format, "importKey");
    data = format === "jwk" ? jwkDictionary(data) : bufferSource(data, "importKey", "2nd");
    a = algorithm(a);
    usages = usageList(usages);
    if (isAkp(a.name)) return importAkp(format, data, a, extractable, usages);
    if (format === "raw-seed") fail("NotSupportedError", `Unable to import ${a.name} using raw-seed format`);
    // ChaCha20-Poly1305 takes raw-secret but not raw, as in Node.
    if (format === "raw" && a.name === "ChaCha20-Poly1305") fail("NotSupportedError");
    if (format === "raw-public" || format === "raw-secret") format = "raw";
    if (a.name === "HMAC" || a.name.startsWith("RSA")) requiredHash(a);
    if (jwkKeyType(a) === "oct") return importSecret(format, data, a, extractable, usages);
    if (format === "raw" && rsaNames.includes(a.name)) fail("NotSupportedError", `Unable to import ${a.name} using raw format`);
    if (format === "jwk") validateJwk(data, a, extractable, usages);
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
      fail("DataError", "Invalid keyData");
    return makeKey(keyAlgorithm(a, k), type, extractable, usages, k);
  }
  // ML-DSA and ML-KEM keys: SPKI, PKCS#8 (the seed form), raw-public, raw-seed and AKP JWK.
  function importAkp(format, data, a, extractable, usages) {
    if (!["spki", "pkcs8", "raw-public", "raw-seed", "jwk"].includes(format))
      fail("NotSupportedError", `Unable to import ${a.name} using ${format} format`);
    if (format === "jwk") validateAkpJwk(data, a, extractable, usages);
    const input = format === "jwk" ? native.utf8Encode(JSON.stringify(data)) : buffer(data);
    const k = backend("import", a, { format, data: native.base64Encode(input, true) }).key;
    const type = k.priv ? "private" : "public";
    return makeKey({ name: a.name }, type, extractable, usages, k);
  }
  function importSecret(format, data, a, extractable, usages) {
    const derivation = ["PBKDF2", "HKDF"].includes(a.name);
    if (!["jwk", "raw"].includes(format) || (derivation && format !== "raw")) fail("NotSupportedError");
    if (derivation && extractable) syntax(`${a.name} keys are not extractable`);
    if (format === "jwk") validateJwk(data, a, extractable, usages);
    const raw = format === "jwk" ? (a.name === "HMAC" ? decodeLenient(data.k) : decode(data.k)) : buffer(data);
    let length = raw.length * 8;
    if (a.name.startsWith("AES-") && ![128, 192, 256].includes(length))
      fail("DataError");
    if (a.name === "ChaCha20-Poly1305" && length !== 256) fail("DataError", "Invalid key length");
    if (a.name === "HMAC") {
      if (!length) fail("DataError", "Zero-length key is not supported");
      if (
        a.length !== undefined &&
        (a.length <= length - 8 || a.length > length || a.length <= 0)
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
  function exportKey(format, key, method = "exportKey") {
    format = keyFormat(format, method);
    const r = record(key);
    if (!r.extractable) fail("InvalidAccessError", "key is not extractable");
    if (isAkp(r.algorithm.name)) return exportAkp(format, r);
    if (format === "raw-seed") fail("NotSupportedError");
    if (format === "raw" && r.algorithm.name === "ChaCha20-Poly1305") fail("NotSupportedError");
    if (format === "raw-public" || format === "raw-secret") format = "raw";
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
  function exportAkp(format, r) {
    const formats = r.type === "private" ? ["pkcs8", "raw-seed", "jwk"] : ["spki", "raw-public", "jwk"];
    if (!formats.includes(format))
      fail("NotSupportedError", `Unable to export ${r.algorithm.name} ${r.type} key using ${format} format`);
    if (format === "jwk") return { ...r.key, key_ops: r.usages.slice(), ext: r.extractable };
    if (format === "raw-seed") return decode(r.key.priv).buffer;
    if (format === "raw-public") return decode(r.key.pub).buffer;
    return decode(backend("export", r.algorithm, { format, key: r.key }).data).buffer;
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
  // A validated operation (CryptoOperationPlan): every argument and key check runs here,
  // before the guest or the host computes anything.
  function signVerifyPlan(op, a, key) {
    a = algorithm(a);
    const r = use(key, a, op);
    const out = operationAlgorithm(a, r);
    // WebCrypto's EcdsaParams has no encoding member: its signatures are always IEEE P1363.
    // `der` is the node:crypto adapter's own backend switch, which a caller's dictionary must
    // not reach.
    delete out.der;
    if (isAkp(a.name)) {
      // FIPS 204 caps the context at 255 bytes; Bun fails both sign and verify past it.
      if (a.context !== undefined && buffer(a.context).length > 255) fail("OperationError");
      out.context = a.context === undefined ? "" : encode(a.context);
    }
    return { op, a, r, out, key };
  }
  function signVerifyRun(plan, data, signature) {
    const result = backend(plan.op, plan.out, {
      key: plan.r.key,
      data: encode(data),
      ...(plan.op === "verify" ? { signature: encode(signature) } : {}),
    });
    return plan.op === "verify" ? result.verified : decode(result.data).buffer;
  }
  function cryptRun(plan, data) {
    return decode(backend(plan.op, plan.out, { key: plan.r.key, data: encode(data) }).data).buffer;
  }
  function cryptPlan(op, a, key, usage = op) {
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
      // Bun rejects a counter that is not one block before it starts the operation.
      if (buffer(a.counter).length !== 16) fail("OperationError");
      out.counter = encode(a.counter);
      out.length = integer(a.length, 1, 128, "counter length");
    }
    if (a.name === "RSA-OAEP")
      out.label = a.label === undefined ? "" : encode(a.label);
    if (a.name === "ChaCha20-Poly1305") {
      if (a.iv === undefined)
        typeError("Member AeadParams.iv is required and must be an instance of (ArrayBufferView or ArrayBuffer)", "ERR_MISSING_OPTION");
      if (buffer(a.iv).length !== 12) fail("OperationError", "algorithm.iv must contain exactly 12 bytes");
      if (a.tagLength !== undefined && a.tagLength !== 128)
        fail("OperationError", `${a.tagLength} is not a valid ChaCha20-Poly1305 tag length`);
      out.iv = encode(a.iv);
      out.additionalData = a.additionalData === undefined ? "" : encode(a.additionalData);
    }
    return { op, a, r, out, key };
  }
  // The ML-KEM key for an encapsulation (public) or decapsulation (private) step.
  function kemKey(a, key, usage, role) {
    a = algorithm(a);
    if (!allowed[a.name].includes(usage)) fail("NotSupportedError", "Algorithm does not support this operation");
    const r = record(key);
    if (r.algorithm.name !== a.name) fail("InvalidAccessError", "key algorithm mismatch");
    if (!r.usages.includes(usage)) fail("InvalidAccessError", `${role} does not have ${usage} usage`);
    return { a, r };
  }
  function encapsulate(a, key, usage) {
    const k = kemKey(a, key, usage, "encapsulationKey");
    const result = backend("encapsulate", k.a, { key: k.r.key });
    return { sharedKey: decode(result.sharedKey), ciphertext: decode(result.ciphertext).buffer };
  }
  function decapsulate(a, key, ciphertext, usage) {
    const k = kemKey(a, key, usage, "decapsulationKey");
    return decode(backend("decapsulate", k.a, { key: k.r.key, ciphertext: encode(ciphertext) }).data);
  }
  function deriveBits(a, key, length, usage = "deriveBits") {
    a = algorithm(a);
    const r = use(key, a, usage);
    const out = operationAlgorithm(a, r);
    const agreement = a.name === "ECDH" || a.name === "X25519";
    const max = a.name === "X25519" ? 256 : { "P-384": 384, "P-521": 528 }[r.algorithm.namedCurve] ?? 256;
    if (length == null && agreement) length = max;
    integer(length, 0, 0x7fffffff, "derived length");
    // A key agreement keeps the leading bits of a length that is not a multiple of 8.
    if (!agreement && length % 8)
      fail("OperationError", "length must be a multiple of 8");
    if (agreement && length > max) fail("OperationError", "derived bit length is too small");
    const extra = { key: r.key, length: Math.ceil(length / 8) };
    if (agreement) {
      const p = record(a.public);
      if (p.type !== "public") fail("InvalidAccessError");
      if (p.algorithm.name !== a.name) fail("InvalidAccessError", "key algorithm mismatch");
      if (p.algorithm.namedCurve !== r.algorithm.namedCurve) fail("InvalidAccessError", "Named curve mismatch");
      extra.public = p.key;
      delete out.public;
    } else {
      requiredHash(a);
      out.hash = a.hash;
      out.salt = encode(a.salt);
      if (a.name === "HKDF") out.info = encode(a.info);
      else out.iterations = integer(a.iterations, 1, 0xffffffff, "iterations");
    }
    const bits = decode(backend("derive", out, extra).data);
    if (length % 8) bits[bits.length - 1] &= 0xff << (8 - (length % 8));
    return bits.buffer;
  }
  // The browser engine computes digests, AES and signatures on the host's own Web Crypto
  // when it supports them; the checks above always run first, here.
  const hostCompute = native.hostCrypto
    ? internal.require("crypto_host_compute")(native.hostCrypto, { buffer, decode })
    : undefined;
  // A guest computation done now whose result or failure settles in a later task, after
  // microtasks already queued: Bun runs digests, encryption, signatures, derivation and
  // non-AES-KW wrapping as background work (the Web Crypto spec's "queue a task"). Argument
  // errors are thrown before one is made, so they still reject at once.
  class Later {
    constructor(compute) {
      this.failed = false;
      try {
        this.value = compute();
      } catch (error) {
        this.failed = true;
        this.error = error;
      }
    }
  }
  // Host work, which settles in the host's own task. A key the host refused is computed by the
  // guest from the call-time copy (`work.input`); any other host failure is the operation's own
  // failure (a bad tag or padding), reported as the guest and Bun report it, without computing
  // again.
  class HostWork {
    constructor(work, guest) {
      this.promise = work.promise.then(value => value, error => {
        if (error === hostCompute.refused) return guest(work.input);
        return fail("OperationError");
      });
    }
  }
  function offload(work, data, guest) {
    return work ? new HostWork(work, guest) : new Later(() => guest(data));
  }
  function laterResult(later) {
    return new Promise((resolve, reject) =>
      internal.realTimers.setImmediate(() => (later.failed ? reject(later.error) : resolve(later.value))));
  }
  // Every SubtleCrypto method: a rejected promise for a bad receiver or argument. Key
  // management, AES-KW wrapping and the ML-KEM methods resolve at once, as in Bun.
  function settle(receiver, method, run) {
    try {
      if (receiver !== subtleInstance)
        typeError(`Can only call SubtleCrypto.${method} on instances of SubtleCrypto`, "ERR_INVALID_THIS");
      const result = run();
      if (result instanceof HostWork) return result.promise;
      if (result instanceof Later) return laterResult(result);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function digest(a, data) {
    const name = algorithm(a, true).name;
    const bytes = view(data);
    return offload(hostCompute?.digest(name, bytes), bytes, input => native.hash(name, input).buffer);
  }
  function signVerify(op, a, key, data, signature) {
    const plan = signVerifyPlan(op, a, key);
    const bytes = view(data);
    if (op === "sign") return offload(hostCompute?.sign(plan, bytes), bytes, input => signVerifyRun(plan, input));
    const sig = buffer(signature);
    return offload(hostCompute?.verify(plan, sig, bytes), bytes, input => signVerifyRun(plan, input, sig));
  }
  function cryptOperation(op, a, key, data) {
    const plan = cryptPlan(op, a, key);
    const bytes = view(data);
    return offload(hostCompute?.crypt(plan, bytes), bytes, input => cryptRun(plan, input));
  }
  function publicKey(key, usages) {
    usages = usageList(usages);
    const r = record(key);
    if (r.type !== "private") fail(r.type === "secret" ? "NotSupportedError" : "InvalidAccessError", "key must be a private key");
    const k = { ...r.key };
    for (const field of ["d", "p", "q", "dp", "dq", "qi", "priv"]) delete k[field];
    return makeKey(r.algorithm, "public", true, usages, k);
  }
  class SubtleCrypto {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
    digest(a, data) {
      return settle(this, "digest", () => digest(a, data));
    }
    generateKey(a, extractable, usages) {
      return settle(this, "generateKey", () => generate(a, extractable, usages));
    }
    importKey(format, data, a, extractable, usages) {
      return settle(this, "importKey", () => importKey(format, data, a, extractable, usages));
    }
    exportKey(format, key) {
      return settle(this, "exportKey", () => exportKey(format, key));
    }
    // The public half of a private key, always extractable, as in Bun.
    getPublicKey(key, usages) {
      return settle(this, "getPublicKey", () => publicKey(key, usages));
    }
    sign(a, key, data) {
      return settle(this, "sign", () => signVerify("sign", a, key, data));
    }
    verify(a, key, signature, data) {
      return settle(this, "verify", () => signVerify("verify", a, key, data, signature));
    }
    encrypt(a, key, data) {
      return settle(this, "encrypt", () => cryptOperation("encrypt", a, key, data));
    }
    decrypt(a, key, data) {
      return settle(this, "decrypt", () => cryptOperation("decrypt", a, key, data));
    }
    // Node orders encapsulateBits results sharedKey first and encapsulateKey results
    // ciphertext first; Bun does the same.
    encapsulateBits(a, key) {
      return settle(this, "encapsulateBits", () => {
        const result = encapsulate(a, key, "encapsulateBits");
        return { sharedKey: result.sharedKey.buffer, ciphertext: result.ciphertext };
      });
    }
    encapsulateKey(a, key, sharedKeyAlgorithm, extractable, usages) {
      return settle(this, "encapsulateKey", () => {
        const result = encapsulate(a, key, "encapsulateKey");
        return {
          ciphertext: result.ciphertext,
          sharedKey: importKey("raw-secret", result.sharedKey, sharedKeyAlgorithm, extractable, usages),
        };
      });
    }
    decapsulateBits(a, key, ciphertext) {
      return settle(this, "decapsulateBits", () => decapsulate(a, key, ciphertext, "decapsulateBits").buffer);
    }
    decapsulateKey(a, key, ciphertext, sharedKeyAlgorithm, extractable, usages) {
      return settle(this, "decapsulateKey", () =>
        importKey("raw-secret", decapsulate(a, key, ciphertext, "decapsulateKey"), sharedKeyAlgorithm, extractable, usages));
    }
    // length is optional in WebIDL, so the method's length is 2.
    deriveBits(a, key, length = undefined) {
      return settle(this, "deriveBits", () => {
        const bits = deriveBits(a, key, length);
        return new Later(() => bits);
      });
    }
    deriveKey(a, key, derived, extractable, usages) {
      return settle(this, "deriveKey", () => {
        const secret = deriveSecretKey(a, key, derived, extractable, usages);
        return new Later(() => secret);
      });
    }
    wrapKey(format, key, wrappingKey, a) {
      return settle(this, "wrapKey", () => wrapKey(format, key, wrappingKey, a));
    }
    unwrapKey(format, wrapped, key, a, unwrapped, extractable, usages) {
      return settle(this, "unwrapKey", () => unwrapKey(format, wrapped, key, a, unwrapped, extractable, usages));
    }
    get [Symbol.toStringTag]() {
      return "SubtleCrypto";
    }
  }
  function deriveSecretKey(a, key, derived, extractable, usages) {
    derived = algorithm(derived);
    // Only key types with a key length can be derived; Bun's normalization rejects the rest.
    if (jwkKeyType(derived) !== "oct") fail("NotSupportedError", "Unrecognized algorithm name");
    if (derived.name === "HMAC") requiredHash(derived);
    const length =
      derived.name === "ChaCha20-Poly1305"
        ? 256
        : (derived.length ?? (derived.name === "HMAC" ? blockBits[requiredHash(derived).name] : undefined));
    return importKey(
      "raw-secret",
      deriveBits(a, key, length, "deriveKey"),
      derived,
      extractable,
      usages,
    );
  }
  // Bun wraps and unwraps with AES-KW at once and runs the other algorithms as background
  // work, whose results and failures settle in a later task.
  function wrapKey(format, key, wrappingKey, a) {
    format = keyFormat(format, "wrapKey");
    const data = exportKey(format, key, "wrapKey");
    let bytes =
      format === "jwk" ? native.utf8Encode(JSON.stringify(data)) : data;
    if (format === "jwk" && algorithm(a).name === "AES-KW") {
      const padded = new Uint8Array(Math.ceil(bytes.length / 8) * 8).fill(32);
      padded.set(bytes);
      bytes = padded;
    }
    const plan = cryptPlan("encrypt", a, wrappingKey, "wrapKey");
    const input = buffer(bytes);
    const run = () => cryptRun(plan, input);
    return plan.a.name === "AES-KW" ? run() : new Later(run);
  }
  function unwrapKey(format, wrapped, key, a, unwrapped, extractable, usages) {
    format = keyFormat(format, "unwrapKey");
    // Bun normalizes the unwrapped key's algorithm before it decrypts.
    unwrapped = algorithm(unwrapped);
    const plan = cryptPlan("decrypt", a, key, "unwrapKey");
    const input = buffer(wrapped);
    const run = () => importUnwrapped(format, cryptRun(plan, input), unwrapped, extractable, usages);
    return plan.a.name === "AES-KW" ? run() : new Later(run);
  }
  function importUnwrapped(format, bytes, unwrapped, extractable, usages) {
    if (format !== "jwk")
      return importKey(format, bytes, unwrapped, extractable, usages);
    let jwk;
    try {
      jwk = JSON.parse(native.utf8Decode(new Uint8Array(bytes), true));
    } catch {
      fail("DataError", "WrappedKey cannot be converted to a JSON object");
    }
    return importKey(format, jwk, unwrapped, extractable, usages);
  }
  const cryptoObject = globalThis.crypto;
  const subtleInstance = Object.create(SubtleCrypto.prototype);
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
    isKey: (value) => material.has(value),
    record,
    cloneKey: (value) => (material.has(value) ? cloneKey(value) : undefined),
    serializeKey,
    deserializeKey,
    makeKey,
    generate,
    importKey,
    exportKey,
    deriveBits,
    backend,
    algorithm,
    encode,
    decode,
    keyAlgorithm,
  };
  return (defineGlobal) => {
    defineGlobal("Crypto", Crypto);
    Object.setPrototypeOf(globalThis.crypto, Crypto.prototype);
    defineGlobal("CryptoKey", CryptoKey);
    defineGlobal("SubtleCrypto", SubtleCrypto);
  };
});
