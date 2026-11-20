// SubtleCrypto rejects bad usages, formats and keys with the error names and messages Bun prints.
const subtle = crypto.subtle;
const rsa = (name: string) => ({ name, modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" });

function describe(error: unknown): string {
  if (!(error instanceof Error)) return `non-error ${String(error)}`;
  const code = (error as Error & { code?: string }).code;
  const kind = error instanceof DOMException ? "DOMException" : error.constructor.name;
  return `${kind} ${error.name}${code ? ` ${code}` : ""}: ${error.message}`;
}

async function show(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    const type = value && typeof value === "object" && "type" in value ? (value as CryptoKey).type : typeof value;
    console.log(label, "->", "resolved", type);
  } catch (error) {
    console.log(label, "->", describe(error));
  }
}

const usage = (name: string) => name as KeyUsage;

console.log("== generateKey usages");
await show("AES-CBC sign", () => subtle.generateKey({ name: "AES-CBC", length: 256 }, true, ["sign"]));
await show("AES-KW encrypt", () => subtle.generateKey({ name: "AES-KW", length: 128 }, true, ["encrypt"]));
await show("HMAC encrypt", () => subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["encrypt"]));
await show("RSA-OAEP sign", () => subtle.generateKey(rsa("RSA-OAEP"), true, ["sign"]));
await show("RSA-PSS encrypt", () => subtle.generateKey(rsa("RSA-PSS"), true, ["encrypt"]));
for (const name of ["RSASSA-PKCS1-v1_5", "RSA-OAEP", "RSA-PSS"]) {
  for (const kem of ["encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits"]) {
    await show(`${name} ${kem}`, () => subtle.generateKey(rsa(name), true, [usage(kem)]));
  }
}
await show("ECDSA encrypt", () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["encrypt"]));
await show("ECDH sign", () => subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["sign"]));
await show("Ed25519 encrypt", () => subtle.generateKey("Ed25519", true, ["encrypt"]));
await show("X25519 sign", () => subtle.generateKey("X25519", true, ["sign"]));

console.log("== empty usages");
await show("generate AES-GCM", () => subtle.generateKey({ name: "AES-GCM", length: 256 }, false, []));
await show("generate HMAC", () => subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, []));
await show("generate ECDSA", () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, []));
await show("generate Ed25519", () => subtle.generateKey("Ed25519", false, []));
await show("import raw AES-GCM", () => subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, []));
await show("import raw HMAC", () => subtle.importKey("raw", new Uint8Array(16), { name: "HMAC", hash: "SHA-256" }, false, []));
await show("import raw PBKDF2", () => subtle.importKey("raw", new Uint8Array(16), "PBKDF2", false, []));
const pb = await subtle.importKey("raw", new Uint8Array(16), "PBKDF2", false, ["deriveKey"]);
const pbkdf2 = { name: "PBKDF2", salt: new Uint8Array(8), iterations: 1, hash: "SHA-256" };
await show("deriveKey AES-GCM", () => subtle.deriveKey(pbkdf2, pb, { name: "AES-GCM", length: 256 }, false, []));
const kw = await subtle.generateKey({ name: "AES-KW", length: 256 }, true, ["wrapKey", "unwrapKey"]);
const hm = await subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const wrapped = await subtle.wrapKey("raw", hm, kw, "AES-KW");
await show("unwrapKey HMAC", () => subtle.unwrapKey("raw", wrapped, kw, "AES-KW", { name: "HMAC", hash: "SHA-256" }, false, []));

console.log("== importKey usages");
const pss = (await subtle.generateKey(rsa("RSA-PSS"), true, ["sign", "verify"])) as CryptoKeyPair;
const spki = await subtle.exportKey("spki", pss.publicKey);
const pkcs8 = await subtle.exportKey("pkcs8", pss.privateKey);
await show("RSA-PSS spki encrypt", () => subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-256" }, true, ["encrypt"]));
await show("RSASSA spki encrypt", () => subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["encrypt"]));
await show("RSA-OAEP spki sign", () => subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["sign"]));
await show("RSA-PSS spki sign", () => subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]));
await show("RSA-PSS pkcs8 verify", () => subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]));
await show("RSA-PSS pkcs8 empty", () => subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-256" }, true, []));
await show("AES-GCM raw sign", () => subtle.importKey("raw", new Uint8Array(16), "AES-GCM", true, ["sign"]));
await show("HMAC raw encrypt", () => subtle.importKey("raw", new Uint8Array(16), { name: "HMAC", hash: "SHA-256" }, true, ["encrypt"]));
await show("PBKDF2 raw encrypt", () => subtle.importKey("raw", new Uint8Array(16), "PBKDF2", false, ["encrypt"]));
const ec = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const ecSpki = await subtle.exportKey("spki", ec.publicKey);
await show("ECDSA spki sign", () => subtle.importKey("spki", ecSpki, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]));
await show("ECDH spki deriveBits", () => subtle.importKey("spki", ecSpki, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
const ed = (await subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const edRaw = await subtle.exportKey("raw", ed.publicKey);
await show("Ed25519 raw sign", () => subtle.importKey("raw", edRaw, "Ed25519", true, ["sign"]));
await show("X25519 raw deriveBits", () => subtle.importKey("raw", edRaw, "X25519", true, ["deriveBits"]));

console.log("== deriveBits");
const x = (await subtle.generateKey("X25519", false, ["deriveBits"])) as CryptoKeyPair;
const ecdh = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
const ecdh384 = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, false, ["deriveBits"])) as CryptoKeyPair;
await show("X25519 with ECDH public", () => subtle.deriveBits({ name: "X25519", public: ecdh.publicKey }, x.privateKey, 256));
await show("ECDH with X25519 public", () => subtle.deriveBits({ name: "ECDH", public: x.publicKey } as EcdhKeyDeriveParams, ecdh.privateKey, 256));
await show("ECDH with P-384 public", () => subtle.deriveBits({ name: "ECDH", public: ecdh384.publicKey }, ecdh.privateKey, 256));
await show("ECDH with private as public", () => subtle.deriveBits({ name: "ECDH", public: ecdh.privateKey }, ecdh.privateKey, 256));
const methods = ["decrypt", "deriveBits", "deriveKey", "digest", "encrypt", "exportKey", "generateKey", "importKey", "sign", "unwrapKey", "verify", "wrapKey"];
console.log("lengths", JSON.stringify(Object.fromEntries(methods.map(name => [name, (SubtleCrypto.prototype as unknown as Record<string, () => void>)[name].length]))));
const ecdhTrailing = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
const full = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ecdhTrailing.publicKey }, ecdhTrailing.privateKey, 256));
for (const length of [1, 9, 255]) {
  const bits = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ecdhTrailing.publicKey }, ecdhTrailing.privateKey, length));
  const keep = 0xff << (8 - (length % 8 || 8)) & 0xff;
  console.log("ECDH", length, "bits:", bits.length, "bytes, leading bits kept", bits.slice(0, -1).every((byte, i) => byte === full[i]) && bits[bits.length - 1] === (full[bits.length - 1] & keep));
}
await show("ECDH 257 bits", () => subtle.deriveBits({ name: "ECDH", public: ecdhTrailing.publicKey }, ecdhTrailing.privateKey, 257));
await show("HKDF 7 bits", async () => subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(1), info: new Uint8Array(1) }, await subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["deriveBits"]), 7));

console.log("== export and wrap");
const sealed = (await subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
const kek = await subtle.importKey("raw", new Uint8Array(32), "AES-KW", false, ["wrapKey"]);
await show("exportKey pkcs8 non-extractable", () => subtle.exportKey("pkcs8", sealed.privateKey));
await show("wrapKey pkcs8 non-extractable", () => subtle.wrapKey("pkcs8", sealed.privateKey, kek, "AES-KW"));

console.log("== HMAC JWK members");
const k = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const hmac = { name: "HMAC", hash: "SHA-256" };
const jwks: Array<[string, JsonWebKey]> = [
  ["use enc", { kty: "oct", k, use: "enc" }],
  ["key_ops verify", { kty: "oct", k, key_ops: ["verify"] }],
  ["ext false", { kty: "oct", k, ext: false }],
  ["empty k", { kty: "oct", k: "!!!" }],
  ["use and alg", { kty: "oct", k, use: "enc", alg: "HS384" }],
  ["use and empty k", { kty: "oct", k: "!!!", use: "enc" }],
  ["alg HS384", { kty: "oct", k, alg: "HS384" }],
  ["duplicate key_ops", { kty: "oct", k, key_ops: ["sign", "sign"] }],
  ["duplicate key_ops with use", { kty: "oct", k, use: "enc", key_ops: ["sign", "sign"] }],
  ["kty RSA", { kty: "RSA", k }],
];
for (const [label, jwk] of jwks) await show(label, () => subtle.importKey("jwk", jwk, hmac, true, ["sign"]));
await show("AES use sig", () => subtle.importKey("jwk", { kty: "oct", k: "AAAAAAAAAAAAAAAAAAAAAA", use: "sig" }, "AES-GCM", true, ["encrypt"]));
await show("AES key_ops mismatch", () => subtle.importKey("jwk", { kty: "oct", k: "AAAAAAAAAAAAAAAAAAAAAA", key_ops: ["decrypt"] }, "AES-GCM", true, ["encrypt"]));
await show("AES alg mismatch", () => subtle.importKey("jwk", { kty: "oct", k: "AAAAAAAAAAAAAAAAAAAAAA", alg: "A256GCM" }, "AES-GCM", true, ["encrypt"]));
await show("AES ext false", () => subtle.importKey("jwk", { kty: "oct", k: "AAAAAAAAAAAAAAAAAAAAAA", ext: false }, "AES-GCM", true, ["encrypt"]));

console.log("== argument checks");
await show("raw plain object", () => subtle.importKey("raw", {} as BufferSource, "AES-GCM", true, ["encrypt"]));
await show("raw string", () => subtle.importKey("raw", "abc" as unknown as BufferSource, "AES-GCM", true, ["encrypt"]));
let coerced = 0;
const format = { toString: () => (coerced++, "bogus") } as unknown as "raw";
await show("bogus format", () => subtle.importKey(format, new Uint8Array(16), "AES-GCM", true, ["encrypt"]));
console.log("format coerced", coerced);
await show("bogus algorithm", () => subtle.generateKey({ name: "bogus" }, true, ["sign"]));
await show("bogus digest", () => subtle.digest("bogus", new Uint8Array(1)));
await show("unwrapKey bogus unwrapped type", () => subtle.unwrapKey("raw", new Uint8Array(40), kw, "AES-KW", { name: "bogus" }, false, ["sign"]));
await show("RSAES-PKCS1-v1_5", () => subtle.generateKey(rsa("RSAES-PKCS1-v1_5"), true, ["encrypt"]));

console.log("== operation failures");
const gcm = await subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
await show("AES-GCM undersized", () => subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, gcm, new Uint8Array(5)));
await show("AES-GCM bad tag", () => subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, gcm, new Uint8Array(32)));
await show("sign without usage", () => subtle.sign("HMAC", gcm, new Uint8Array(1)));
await show("encrypt with wrong algorithm", () => subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, gcm, new Uint8Array(1)));
const verifyOnly = await subtle.importKey("raw", new Uint8Array(16), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
await show("sign with a verify-only key", () => subtle.sign("HMAC", verifyOnly, new Uint8Array(1)));
await show("exportKey raw non-extractable", () => subtle.exportKey("raw", verifyOnly));
await show("exportKey jwk non-extractable", () => subtle.exportKey("jwk", verifyOnly));
await show("exportKey spki of a private key", () => subtle.exportKey("spki", pss.privateKey));
await show("importKey pkcs8 from spki bytes", () => subtle.importKey("pkcs8", spki, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]));

console.log("== formats and key types");
await show("raw-public RSA-OAEP", () => subtle.importKey("raw-public", new Uint8Array(32), { name: "RSA-OAEP", hash: "SHA-256" }, false, []));
await show("raw-public HKDF", () => subtle.importKey("raw-public", new Uint8Array(32), "HKDF", false, ["deriveBits"]));
await show("raw-secret AES-GCM", () => subtle.importKey("raw-secret", new Uint8Array(16), "AES-GCM", false, ["encrypt"]));
await show("raw-public Ed25519", () => subtle.importKey("raw-public", edRaw, "Ed25519", false, ["verify"]));
await show("spki AES-GCM", () => subtle.importKey("spki", new Uint8Array(16), "AES-GCM", false, ["encrypt"]));
await show("HKDF extractable", () => subtle.importKey("raw", new Uint8Array(16), "HKDF", true, ["deriveBits"]));
await show("HKDF encrypt", () => subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["encrypt"]));
await show("bogus usage", () => subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["bogus" as KeyUsage]));
await show("jwk bogus key_ops", () => subtle.importKey("jwk", { kty: "oct", k: "AAAAAAAAAAAAAAAAAAAAAA", key_ops: ["bogus"] }, "AES-GCM", true, ["encrypt"]));
await show("deriveKey ECDSA", () => subtle.deriveKey(pbkdf2, pb, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]));
const edPkcs8 = await subtle.exportKey("pkcs8", ed.privateKey);
const edSpki = await subtle.exportKey("spki", ed.publicKey);
await show("Ed25519 spki as X25519", () => subtle.importKey("spki", edSpki, "X25519", true, []));
await show("Ed25519 pkcs8 as X25519", () => subtle.importKey("pkcs8", edPkcs8, "X25519", true, ["deriveBits"]));
await show("Ed25519 spki as ECDSA", () => subtle.importKey("spki", edSpki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await show("Ed25519 spki as RSA-PSS", () => subtle.importKey("spki", edSpki, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]));
await show("RSA spki as Ed25519", () => subtle.importKey("spki", spki, "Ed25519", true, ["verify"]));
await show("P-256 spki as P-384", () => subtle.importKey("spki", ecSpki, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]));
const edJwk = await subtle.exportKey("jwk", ed.privateKey);
const seed = Buffer.from(edJwk.d!, "base64url");
const edPublic = Buffer.from(edJwk.x!, "base64url");
await show("Ed25519 64-byte d", () => subtle.importKey("jwk", { ...edJwk, d: Buffer.concat([seed, edPublic]).toString("base64url") }, "Ed25519", true, ["sign"]));
await show("Ed25519 64-byte d, wrong half", () => subtle.importKey("jwk", { ...edJwk, d: Buffer.concat([seed, Buffer.alloc(32)]).toString("base64url") }, "Ed25519", true, ["sign"]));
await show("Ed25519 jwk with another x", () => subtle.importKey("jwk", { ...edJwk, x: Buffer.alloc(32, 1).toString("base64url") }, "Ed25519", true, ["sign"]));
