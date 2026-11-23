// WebCrypto SHA3-256/384/512: digests (FIPS 202 vectors), HMAC with the hash's block size
// as the default length, RSA-PSS and ECDSA with SHA-3, PBKDF2 and HKDF, and the JWK "alg"
// JOSE does not define.
const subtle = crypto.subtle;
const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");
const report = async (label: string, run: () => Promise<unknown>) => {
  try {
    const value = await run();
    console.log(label, value instanceof ArrayBuffer ? hex(value) : typeof value === "object" ? JSON.stringify(value) : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code ?? "", failure.message);
  }
};
const abc = new TextEncoder().encode("abc");
for (const hash of ["SHA3-256", "SHA3-384", "SHA3-512", "sha3-256"]) {
  await report(`digest ${hash}`, () => subtle.digest(hash, abc));
}
await report("digest SHA3-1024", () => subtle.digest("SHA3-1024", abc));
await report("digest large", async () => hex(await subtle.digest("SHA3-256", new Uint8Array(100_000).fill(97))).slice(0, 16));

for (const hash of ["SHA3-256", "SHA3-384", "SHA3-512"]) {
  const key = (await subtle.generateKey({ name: "HMAC", hash }, true, ["sign", "verify"])) as CryptoKey;
  const jwk = await subtle.exportKey("jwk", key);
  console.log("hmac", hash, JSON.stringify(key.algorithm), (await subtle.exportKey("raw", key)).byteLength, jwk.alg);
}
const keyBytes = new Uint8Array(32).map((_, i) => i);
const hmac = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA3-256" }, false, ["sign", "verify"]);
const tag = await subtle.sign("HMAC", hmac, new TextEncoder().encode("Sample message for keylen<blocklen"));
console.log("hmac vector", hex(tag), await subtle.verify("HMAC", hmac, tag, new TextEncoder().encode("Sample message for keylen<blocklen")));

const rsa = (await subtle.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA3-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const signature = await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, rsa.privateKey, abc);
const rsaJwk = await subtle.exportKey("jwk", rsa.publicKey);
console.log("rsa-pss", JSON.stringify(rsa.publicKey.algorithm.hash), signature.byteLength, await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, rsa.publicKey, signature, abc), rsaJwk.alg);
const reimported = await subtle.importKey("jwk", rsaJwk, { name: "RSA-PSS", hash: "SHA3-256" }, true, ["verify"]);
console.log("rsa-pss reimport", await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, reimported, signature, abc));
const ec = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const ecSignature = await subtle.sign({ name: "ECDSA", hash: "SHA3-384" }, ec.privateKey, abc);
console.log("ecdsa", ecSignature.byteLength, await subtle.verify({ name: "ECDSA", hash: "SHA3-384" }, ec.publicKey, ecSignature, abc));

const pbkdf2 = await subtle.importKey("raw", new TextEncoder().encode("pw"), "PBKDF2", false, ["deriveBits"]);
await report("pbkdf2", () => subtle.deriveBits({ name: "PBKDF2", hash: "SHA3-256", salt: new TextEncoder().encode("salt"), iterations: 1000 }, pbkdf2, 256));
const hkdf = await subtle.importKey("raw", new Uint8Array(16).fill(7), "HKDF", false, ["deriveBits"]);
await report("hkdf", () => subtle.deriveBits({ name: "HKDF", hash: "SHA3-512", salt: new Uint8Array(4), info: new Uint8Array(2) }, hkdf, 128));
