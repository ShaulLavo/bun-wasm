// Digest names for node:crypto createHash/createHmac and Bun.CryptoHasher, mapped onto
// the canonical names `native.nodeDigest` and `native.nodeHmac` take (node_digest.rs).
// Measured against native Bun 1.4.4, whose node:crypto looks names up in this order:
// ncrypto's getDigestByName rules (src/jsc/bindings/ncrypto.cpp), then BoringSSL's
// case-sensitive EVP_get_digestbyname table, then Bun's own case-insensitive hasher
// map (src/runtime/crypto/EVP.rs). createHmac uses only the first two.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Canonical = "md4" | "md5" | "md5-sha1" | "sha1" | "sha224" | "sha256" | "sha384" | "sha512" | "sha512-224" | "sha512-256" | "sha3-224" | "sha3-256" | "sha3-384" | "sha3-512" | "shake128" | "shake256" | "blake2b256" | "blake2b512" | "blake2s256" | "ripemd160";

  const table = (entries: Record<string, Canonical>): ReadonlyMap<string, Canonical> => new Map(Object.entries(entries));

  // Bun.CryptoHasher's names. Keys are lowercase; lookups ignore ASCII case.
  const HASHER_NAMES = table({
    md4: "md4", md5: "md5", sha1: "sha1", "sha-1": "sha1", sha128: "sha1",
    sha224: "sha224", sha256: "sha256", sha384: "sha384", sha512: "sha512",
    "sha-224": "sha224", "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512",
    "sha3-224": "sha3-224", "sha3-256": "sha3-256", "sha3-384": "sha3-384", "sha3-512": "sha3-512",
    shake128: "shake128", shake256: "shake256", "shake-128": "shake128", "shake-256": "shake256",
    rmd160: "ripemd160", ripemd160: "ripemd160",
    blake2b256: "blake2b256", blake2b512: "blake2b512", blake2s256: "blake2s256",
    "sha-512224": "sha512-224", "sha512-224": "sha512-224", "sha-512/224": "sha512-224", "sha-512_224": "sha512-224",
    "sha-512256": "sha512-256", "sha512-256": "sha512-256", "sha-512/256": "sha512-256", "sha-512_256": "sha512-256",
  });

  // BoringSSL's EVP_get_digestbyname: exact, case-sensitive short and long names.
  const EVP_NAMES = table({
    md4: "md4", MD4: "md4", md5: "md5", MD5: "md5", "md5-sha1": "md5-sha1", "MD5-SHA1": "md5-sha1",
    sha1: "sha1", SHA1: "sha1", sha224: "sha224", SHA224: "sha224", sha256: "sha256", SHA256: "sha256",
    sha384: "sha384", SHA384: "sha384", sha512: "sha512", SHA512: "sha512",
    "sha512-224": "sha512-224", "SHA512-224": "sha512-224", "sha512-256": "sha512-256", "SHA512-256": "sha512-256",
    "sha3-224": "sha3-224", "SHA3-224": "sha3-224", "sha3-256": "sha3-256", "SHA3-256": "sha3-256",
    "sha3-384": "sha3-384", "SHA3-384": "sha3-384", "sha3-512": "sha3-512", "SHA3-512": "sha3-512",
    ripemd160: "ripemd160", RIPEMD160: "ripemd160",
    "RSA-MD5": "md5", md5WithRSAEncryption: "md5",
    sha1WithRSAEncryption: "sha1", sha224WithRSAEncryption: "sha224", sha256WithRSAEncryption: "sha256",
    sha384WithRSAEncryption: "sha384", sha512WithRSAEncryption: "sha512",
    "DSA-SHA": "sha1", "DSA-SHA1": "sha1", dsaWithSHA1: "sha1", "ecdsa-with-SHA1": "sha1",
  });

  // ncrypto's getDigestByName rules, which ignore ASCII case except for "dss1".
  const NCRYPTO_NAMES = table({
    md5: "md5", "rsa-sha1": "sha1", "rsa-sha224": "sha224", "rsa-sha256": "sha256", "rsa-sha384": "sha384", "rsa-sha512": "sha512",
    "sha-1": "sha1", "sha-224": "sha224", "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512",
    "sha-512/224": "sha512-224", "sha-512/256": "sha512-256", "sha-512256": "sha512-256", "sha-512_256": "sha512-256", sha128: "sha1",
  });

  const BYTE_LENGTHS: Readonly<Record<Canonical, number>> = {
    md4: 16, md5: 16, "md5-sha1": 36, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64, "sha512-224": 28, "sha512-256": 32,
    "sha3-224": 28, "sha3-256": 32, "sha3-384": 48, "sha3-512": 64, shake128: 16, shake256: 32,
    blake2b256: 32, blake2b512: 64, blake2s256: 32, ripemd160: 20,
  };

  function ncryptoName(name: string): Canonical | undefined {
    if (name === "dss1" || name === "DSS1") return "sha1";
    return NCRYPTO_NAMES.get(name.toLowerCase());
  }

  /** createHmac's lookup. */
  function hmacName(name: string): Canonical | undefined {
    return ncryptoName(name) ?? EVP_NAMES.get(name);
  }

  /** createHash's lookup. */
  function hashName(name: string): Canonical | undefined {
    return hmacName(name) ?? HASHER_NAMES.get(name.toLowerCase());
  }

  /** Bun.CryptoHasher's lookup. */
  function hasherName(name: string): Canonical | undefined {
    return HASHER_NAMES.get(name.toLowerCase());
  }

  // createHash's options.outputLength, validated like Node's validateUint32.
  function outputLength(options: unknown): number | undefined {
    if (options === null || typeof options !== "object") return undefined;
    const value: unknown = Reflect.get(options, "outputLength");
    if (value === undefined) return undefined;
    if (typeof value !== "number") {
      throw Object.assign(new TypeError(`The "options.outputLength" property must be of type number. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
      const message = Number.isInteger(value) ? `It must be >= 0 && <= 4294967295. Received ${value}` : `It must be an integer. Received ${value}`;
      throw Object.assign(new RangeError(`The value of "options.outputLength" is out of range. ${message}`), { code: "ERR_OUT_OF_RANGE" });
    }
    return value;
  }

  // BoringSSL's error when a fixed-size digest is asked for another length.
  function notXofError(): Error {
    return Object.assign(new Error("error:06000087:public key routines:OPENSSL_internal:NOT_XOF_OR_INVALID_LENGTH"), { code: "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH" });
  }

  return {
    outputLength,
    notXofError,
    hashName,
    hmacName,
    hasherName,
    byteLength: (name: Canonical) => BYTE_LENGTHS[name],
    isXof: (name: Canonical) => name === "shake128" || name === "shake256",
    // Bun.CryptoHasher's HMAC refuses SHAKE and BLAKE2s-256 ("TODOError").
    hasherHmac: (name: Canonical) => name !== "shake128" && name !== "shake256" && name !== "blake2s256",
    // Bun.CryptoHasher.algorithms and crypto.getHashes(), in Bun's order.
    hasherAlgorithms: ["blake2b256", "blake2b512", "blake2s256", "md4", "md5", "ripemd160", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "shake128", "shake256"],
    nodeHashes: ["md4", "md5", "ripemd160", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "sha3-224", "sha3-256", "sha3-384", "sha3-512"],
  };
})
