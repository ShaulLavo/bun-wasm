import crypto from "node:crypto";

// Which digest names node:crypto and Bun's hashers accept, what each maps to, and
// their output-length, copy and digest-once rules.
const failure = (error: unknown) => {
  const value = error as Error & { code?: string };
  return `throws ${value.name} ${value.code} ${value.message}`;
};
const attempt = (make: () => unknown): string => {
  try {
    const value = make();
    return value instanceof Uint8Array ? `${value.constructor.name}(${value.length}) ${Buffer.from(value).toString("hex")}` : String(value);
  } catch (error) {
    return failure(error);
  }
};

const names = ["md4", "md5", "md5-sha1", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "shake128", "shake256", "blake2b256", "blake2b512", "blake2s256", "ripemd160", "rmd160", "ripemd", "sm3", "dss1", "sha128", "sha-1", "sha-512/224", "sha-512/256", "sha-512224", "sha-512256", "sha-512_224", "sha-512_256", "sha512/224", "shake-128", "rsa-md5", "rsa-sha1", "rsa-sha256", "rsa-sha512/224", "rsa-sha3-256", "rsa-ripemd160", "md4WithRSAEncryption", "md5WithRSAEncryption", "sha256WithRSAEncryption", "sha512-224WithRSAEncryption", "ripemd160WithRSA", "ssl3-md5", "DSA-SHA", "dsaWithSHA1", "ecdsa-with-SHA1", "id-rsassa-pkcs1-v1_5-with-sha3-256", "nope"];
const variants = Array.from(new Set(names.flatMap(name => [name, name.toLowerCase(), name.toUpperCase()])));

for (const name of variants) {
  const hash = attempt(() => crypto.createHash(name).update("abc").digest("hex"));
  const hmac = attempt(() => crypto.createHmac(name, "key").update("abc").digest("hex"));
  const hasher = attempt(() => {
    const instance = new Bun.CryptoHasher(name as never);
    return `${instance.algorithm} ${instance.byteLength} ${instance.update("abc").digest("hex")}`;
  });
  console.log(`${name}\n  hash ${hash}\n  hmac ${hmac}\n  hasher ${hasher}`);
}

console.log("long hmac keys", ["sha3-384", "sha512", "md5-sha1", "ripemd160"].map(name => crypto.createHmac(name, "k".repeat(200)).update("abc").digest("hex")).join(" "));
for (const name of Bun.CryptoHasher.algorithms) {
  console.log("hasher hmac", name, attempt(() => new Bun.CryptoHasher(name, "key").update("abc").digest("hex")));
}
console.log("algorithms", JSON.stringify(Bun.CryptoHasher.algorithms));
console.log("getHashes", JSON.stringify(crypto.getHashes()));

for (const [name, options] of [["sha256", { outputLength: 32 }], ["sha256", { outputLength: 16 }], ["shake128", { outputLength: 0 }], ["shake128", { outputLength: 40 }], ["shake256", { outputLength: 5 }], ["shake256", { outputLength: -1 }], ["shake256", { outputLength: 1.5 }], ["shake256", { outputLength: "8" }], ["sha3-256", {}]] as const) {
  console.log("outputLength", name, JSON.stringify(options), attempt(() => crypto.createHash(name, options as crypto.HashOptions).update("abc").digest("hex")));
}
console.log("crypto.hash", crypto.hash("shake256", "abc"), crypto.hash("sha3-256", "abc", "base64"));

const original = crypto.createHash("sha3-256");
original.update("a");
const copy = original.copy();
original.update("b");
console.log("copy", original.digest("hex"), copy.digest("hex"));
console.log("copy after digest", attempt(() => original.copy()));

for (const name of ["MD4", "MD5", "SHA1", "SHA224", "SHA256", "SHA384", "SHA512", "SHA512_256"] as const) {
  const Hash = Bun[name];
  const into = new Uint8Array(Hash.byteLength + 4).fill(0xa5);
  const instance = new Hash().update("ab").update(new TextEncoder().encode("c"));
  console.log(name, Hash.name, Hash.byteLength, Hash.hash("abc", "hex"), attempt(() => Hash.hash("abc")), instance.digest(into) === into, Buffer.from(into).toString("hex"));
}
const md5 = new Bun.MD5();
console.log("MD5 instance", md5 instanceof Bun.MD5, (md5 as unknown as { byteLength: number }).byteLength, Object.getOwnPropertyNames(Bun.MD5).sort().join(","), Object.getOwnPropertyNames(Bun.MD5.prototype).sort().join(","));
md5.update("abc");
console.log("MD5 digest", attempt(() => md5.digest()));
console.log("MD5 twice", attempt(() => md5.digest("hex")));
console.log("MD5 update after", attempt(() => md5.update("a")));
console.log("MD5 small target", attempt(() => new Bun.MD5().digest(new Uint8Array(4))));
console.log("MD5 call", attempt(() => (Bun.MD5 as unknown as () => unknown)()));
