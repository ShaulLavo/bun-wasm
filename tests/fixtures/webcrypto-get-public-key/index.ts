// SubtleCrypto.getPublicKey for the classic key types: the public half of a private key,
// always extractable, with Bun's usage and key-type errors.
const subtle = crypto.subtle;
const algorithms = [
  [{ name: "ECDSA", namedCurve: "P-256" }, ["sign", "verify"], ["verify"]],
  [{ name: "ECDH", namedCurve: "P-384" }, ["deriveBits"], []],
  [{ name: "ECDSA", namedCurve: "P-521" }, ["sign", "verify"], ["verify"]],
  ["Ed25519", ["sign", "verify"], ["verify"]],
  ["X25519", ["deriveBits"], []],
  [{ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, ["sign", "verify"], ["verify"]],
  [{ name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, ["decrypt", "encrypt"], ["encrypt"]],
] as const;
for (const [algorithm, usages, publicUsages] of algorithms) {
  const pair = (await subtle.generateKey(algorithm as never, false, usages as never)) as CryptoKeyPair;
  const label = typeof algorithm === "string" ? algorithm : `${algorithm.name} ${"namedCurve" in algorithm ? algorithm.namedCurve : ""}`;
  const key = await subtle.getPublicKey(pair.privateKey, publicUsages as never);
  const same = Buffer.from(await subtle.exportKey("spki", key)).equals(Buffer.from(await subtle.exportKey("spki", pair.publicKey)));
  console.log("getPublicKey", label, key.type, key.extractable, JSON.stringify(key.usages), JSON.stringify(key.algorithm) === JSON.stringify(pair.publicKey.algorithm), same);
  await subtle.getPublicKey(pair.privateKey, ["sign"]).then(
    () => console.log("getPublicKey", label, "private usage accepted"),
    error => console.log("getPublicKey", label, "private usage", error.name, error.message),
  );
  await subtle.getPublicKey(pair.publicKey, publicUsages as never).then(
    () => console.log("getPublicKey", label, "public key accepted"),
    error => console.log("getPublicKey", label, "public key", error.name, error.message),
  );
}
const secret = await subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
await subtle.getPublicKey(secret, []).catch(error => console.log("getPublicKey secret", error.name, error.message));
console.log("getPublicKey length", subtle.getPublicKey.length);
