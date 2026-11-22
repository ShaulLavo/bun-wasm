import crypto from "node:crypto";

// generateKeyPair's "rsa-pss" options as Bun checks them before its BoringSSL refuses the key
// type, and the error a JWK export of a P-224 key reports. Emitting a DeprecationWarning
// reads process.noDeprecation; the getter counts those reads (and returns true, so nothing
// reaches stderr) or throws.
const show = (label: string, run: () => unknown) => {
  try {
    console.log(label, String(run()));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};
let warnings = 0;
let throwing = false;
Object.defineProperty(process, "noDeprecation", {
  configurable: true,
  get() {
    if (throwing) throw new Error("noDeprecation getter");
    warnings++;
    return true;
  },
});
const modulusLength = 512;
const pss = (options: object) => () => {
  warnings = 0;
  try {
    crypto.generateKeyPairSync("rsa-pss", { modulusLength, ...options } as never);
  } finally {
    console.log("  warnings", warnings);
  }
};
show("rsa-pss", pss({}));
show("rsa-pss options", pss({ hashAlgorithm: "sha256", mgf1HashAlgorithm: "sha1", saltLength: 16 }));
show("exponent", pss({ publicExponent: 4 }));
show("hash", pss({ hash: "sha256" }));
show("hash type", pss({ hash: 1 }));
show("hash mismatch", pss({ hash: "sha256", hashAlgorithm: "sha1" }));
show("mgf1Hash mismatch", pss({ mgf1Hash: "sha256", mgf1HashAlgorithm: "sha1" }));
show("both deprecated", pss({ hash: "sha256", mgf1Hash: "sha256" }));
show("hashAlgorithm type", pss({ hashAlgorithm: 1 }));
show("bad digest", pss({ hashAlgorithm: "nope" }));
show("bad deprecated digest", pss({ hash: "nope" }));
show("bad mgf1 digest", pss({ mgf1HashAlgorithm: "nope" }));
show("salt range", pss({ saltLength: -1 }));
show("salt type", pss({ saltLength: "1" }));
show("check order", pss({ saltLength: -1, hashAlgorithm: 1 }));
throwing = true;
show("warning throws", pss({ hash: "sha256" }));
show("mgf1 warning throws", pss({ mgf1Hash: "sha256" }));
throwing = false;

// Digest names are Bun's (ncrypto's Digest::FromName), for the hash and MGF1 options alike.
for (const name of ["md4", "sha512-224", "SHA-512/224", "sha3-256", "ripemd160", "md5-sha1", "dss1", "shake128", "blake2b512"]) {
  show(`hashAlgorithm ${name}`, pss({ hashAlgorithm: name }));
  show(`mgf1HashAlgorithm ${name}`, pss({ mgf1HashAlgorithm: name }));
}

// The warning goes through the runtime's own path, not the replaceable process.emitWarning.
const emitWarning = process.emitWarning;
process.emitWarning = () => {
  throw new Error("replaced emitWarning");
};
show("replaced emitWarning", pss({ hash: "sha256" }));
process.emitWarning = emitWarning;

// The options object, the RSA modulus length and exponent, before the PSS options.
const gen = (type: string, options?: unknown) => () => crypto.generateKeyPairSync(type as never, options as never);
show("no options", gen("rsa-pss"));
show("empty options", gen("rsa-pss", {}));
show("string options", gen("rsa-pss", "x"));
show("null options", gen("rsa-pss", null));
show("modulus string", gen("rsa-pss", { modulusLength: "512", hash: "sha256" }));
show("modulus negative", gen("rsa-pss", { modulusLength: -1 }));
show("modulus fraction", gen("rsa-pss", { modulusLength: 1.5 }));
show("modulus 2^32", gen("rsa-pss", { modulusLength: 2 ** 32 }));
show("exponent string", gen("rsa-pss", { modulusLength, publicExponent: "65537" }));
show("exponent null", gen("rsa-pss", { modulusLength, publicExponent: null }));
show("exponent fraction", gen("rsa-pss", { modulusLength, publicExponent: 1.5 }));
show("exponent 2^32", gen("rsa-pss", { modulusLength, publicExponent: 2 ** 32 }));
show("rsa modulus string", gen("rsa", { modulusLength: "512" }));
show("rsa exponent string", gen("rsa", { modulusLength, publicExponent: "3" }));
show("type number", gen(1 as never, { modulusLength }));
show("type unknown", gen("nope", { modulusLength }));
show("ec curve missing", gen("ec", {}));
show("ec curve unknown", gen("ec", { namedCurve: "nope" }));

// Both encodings are checked first, in Bun's order, before the key type's own options.
const p224 = { namedCurve: "secp224r1", privateKeyEncoding: { format: "jwk" } };
show("p224 jwk, public format invalid", gen("ec", { ...p224, publicKeyEncoding: { format: "invalid" } }));
show("p224 jwk, public pem without type", gen("ec", { ...p224, publicKeyEncoding: { format: "pem" } }));
show("p224 jwk", gen("ec", p224));
show("secp256k1 jwk", gen("ec", { namedCurve: "secp256k1", publicKeyEncoding: { format: "jwk" } }));
const encodings: [string, string, object][] = [
  ["public format invalid", "rsa-pss", { publicKeyEncoding: { format: "invalid" } }],
  ["public pkcs1", "rsa-pss", { publicKeyEncoding: { format: "pem", type: "pkcs1" } }],
  ["public string", "rsa-pss", { publicKeyEncoding: "pem" }],
  ["private without type", "rsa-pss", { privateKeyEncoding: { format: "pem" } }],
  ["cipher without passphrase", "rsa-pss", { privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: "aes-128-cbc" } }],
  ["passphrase without cipher", "rsa-pss", { privateKeyEncoding: { format: "pem", type: "pkcs8", passphrase: "x" } }],
  ["der pkcs1 cipher", "rsa", { privateKeyEncoding: { format: "der", type: "pkcs1", cipher: "aes-128-cbc", passphrase: "x" } }],
  ["cipher number", "rsa-pss", { privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: 1, passphrase: "x" } }],
  ["unknown cipher", "rsa-pss", { privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: "nope", passphrase: "x" } }],
  ["rsa private sec1", "rsa", { privateKeyEncoding: { format: "pem", type: "sec1" } }],
  ["modulus string, format invalid", "rsa-pss", { modulusLength: "512", publicKeyEncoding: { format: "invalid" } }],
  ["hash number, format invalid", "rsa-pss", { hash: 1, publicKeyEncoding: { format: "invalid" } }],
];
for (const [label, type, options] of encodings) show(label, gen(type, { modulusLength, ...options }));
show("ec public pkcs8", gen("ec", { namedCurve: "P-256", publicKeyEncoding: { format: "pem", type: "pkcs8" } }));
show("ec private spki", gen("ec", { namedCurve: "P-256", privateKeyEncoding: { format: "pem", type: "spki" } }));
show("ec private raw-public", gen("ec", { namedCurve: "P-256", privateKeyEncoding: { format: "raw-public" } }));

// generateKeyPair throws argument errors before it returns; generation errors reach the
// callback.
const asyncCases: [string, string, unknown][] = [
  ["async modulus string", "rsa-pss", { modulusLength: "512" }],
  ["async bad digest", "rsa-pss", { modulusLength, hashAlgorithm: "nope" }],
  ["async curve unknown", "ec", { namedCurve: "nope" }],
  ["async encoding invalid", "rsa", { modulusLength, publicKeyEncoding: { format: "x" } }],
];
for (const [label, type, options] of asyncCases) {
  show(label, () => crypto.generateKeyPair(type as never, options as never, () => console.log(label, "callback")));
}
show("async callback missing", () => crypto.generateKeyPair("rsa", { modulusLength } as never, undefined as never));

crypto.generateKeyPair("rsa-pss", { modulusLength } as never, (error: (Error & { code?: string }) | null) => {
  console.log("rsa-pss callback", error?.name, error?.code);
  crypto.generateKeyPair(
    "ec",
    { namedCurve: "secp224r1", publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } } as never,
    (error: (Error & { code?: string }) | null) => console.log("p224 jwk", error?.name, error?.code, error?.message),
  );
});
console.log("generateKeyPair returned");
