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
  const jwkMembers = ["alg", "crv", "d", "dp", "dq", "e", "ext", "k", "key_ops", "kty", "n", "oth", "p", "q", "qi", "use", "x", "y"];
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
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
      throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
    if (data.byteLength > 0x7fffffff)
      fail("OperationError", "Crypto input is too large");
    return internal.toUint8(data).slice();
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
        ["sign", "decrypt", "unwrapKey", "deriveKey", "deriveBits"].includes(u),
      );
    return allowed[a.name].filter((u) =>
      ["verify", "encrypt", "wrapKey"].includes(u),
    );
  }
  // Bun's wording differs between generateKey (creating) and importKey.
  function usageMessage(a, creating) {
    if (a.name.startsWith("AES-")) return "Unsupported key usage for an AES key";
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
      usages: usageOrder.filter((usage) => usages.includes(usage)),
      key,
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
    usages = usageList(usages);
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
    if (["HMAC", "PBKDF2", "HKDF"].includes(a.name) || a.name.startsWith("AES-")) return "oct";
    if (a.name.startsWith("RSA")) return "RSA";
    return ["ECDSA", "ECDH"].includes(a.name) ? "EC" : "OKP";
  }
  // HMAC reports Node's member messages; AES and the KDFs only WebCore's generic DataError.
  // The others name "use", "crv" and "alg" problems and call the rest "Invalid keyData".
  function validateJwk(k, a, extractable, usages) {
    const kty = jwkKeyType(a);
    const hmac = a.name === "HMAC";
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
    if (hmac && !decodeLenient(k.k ?? "").length) reject("Zero-length key is not supported");
    if (!hmac) validateJwkOctets(k, reject);
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
        ? { "P-256": "ES256", "P-384": "ES384" }[a.namedCurve]
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
    if (format === "raw-seed") fail("NotSupportedError", `Unable to import ${a.name} using raw-seed format`);
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
  function importSecret(format, data, a, extractable, usages) {
    const derivation = ["PBKDF2", "HKDF"].includes(a.name);
    if (!["jwk", "raw"].includes(format) || (derivation && format !== "raw")) fail("NotSupportedError");
    if (derivation && extractable) syntax(`${a.name} keys are not extractable`);
    if (format === "jwk") validateJwk(data, a, extractable, usages);
    const raw = format === "jwk" ? (a.name === "HMAC" ? decodeLenient(data.k) : decode(data.k)) : buffer(data);
    let length = raw.length * 8;
    if (a.name.startsWith("AES-") && ![128, 192, 256].includes(length))
      fail("DataError");
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
    if (format === "raw-seed") fail("NotSupportedError");
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
    // length is optional in WebIDL, so the method's length is 2.
    async deriveBits(a, key, length = undefined) {
      return deriveBits(a, key, length);
    }
    async deriveKey(a, key, derived, extractable, usages) {
      derived = algorithm(derived);
      // Only key types with a key length can be derived; Bun's normalization rejects the rest.
      if (jwkKeyType(derived) !== "oct") fail("NotSupportedError", "Unrecognized algorithm name");
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
      format = keyFormat(format, "wrapKey");
      const data = exportKey(format, key, "wrapKey");
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
      format = keyFormat(format, "unwrapKey");
      // Bun normalizes the unwrapped key's algorithm before it decrypts.
      unwrapped = algorithm(unwrapped);
      const bytes = crypt("decrypt", a, key, wrapped, "unwrapKey");
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
