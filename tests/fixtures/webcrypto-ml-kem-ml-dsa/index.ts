// WebCrypto ML-KEM-768/1024 and ML-DSA-44/65/87 from fixed seeds: public keys, SPKI,
// PKCS#8 (seed form), raw and AKP JWK encodings, signing with and without a context,
// encapsulation, structuredClone, getPublicKey and Bun's errors. Signatures and
// encapsulations are randomized, so the fixture prints their sizes and checks.
// The browser engine delegates WebCrypto to its host, so this fixture skips it.
const subtle = crypto.subtle;
const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");
const digest = async (b: ArrayBuffer) => hex(await subtle.digest("SHA-256", b)).slice(0, 16);
const report = async (label: string, run: () => Promise<unknown>) => {
  try {
    const value = await run();
    console.log(label, value instanceof ArrayBuffer ? `bytes ${value.byteLength}` : typeof value === "object" ? JSON.stringify(value) : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code ?? "", failure.message);
  }
};
const data = new TextEncoder().encode("message");

for (const name of ["ML-DSA-44", "ML-DSA-65", "ML-DSA-87"]) {
  const seed = new Uint8Array(32).map((_, i) => i + name.length);
  const privateKey = await subtle.importKey("raw-seed", seed, name, true, ["sign"]);
  const publicKey = await subtle.getPublicKey(privateKey, ["verify"]);
  const spki = await subtle.exportKey("spki", publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", privateKey);
  const jwk = await subtle.exportKey("jwk", privateKey);
  console.log(name, JSON.stringify(privateKey.algorithm), privateKey.type, JSON.stringify(privateKey.usages), JSON.stringify(publicKey.usages));
  console.log(name, "spki", spki.byteLength, await digest(spki), "pkcs8", hex(pkcs8).slice(0, 48));
  console.log(name, "raw-public", await digest(await subtle.exportKey("raw-public", publicKey)), "raw-seed", hex(await subtle.exportKey("raw-seed", privateKey)).slice(0, 16));
  console.log(name, "jwk", jwk.kty, jwk.alg, jwk.priv, (jwk.pub as string).length, JSON.stringify(jwk.key_ops), jwk.ext);
  const signature = await subtle.sign(name, privateKey, data);
  const withContext = await subtle.sign({ name, context: new Uint8Array([5]) } as never, privateKey, data);
  console.log(
    name,
    "sign",
    signature.byteLength,
    await subtle.verify(name, publicKey, signature, data),
    await subtle.verify(name, publicKey, signature, new Uint8Array(1)),
    await subtle.verify({ name, context: new Uint8Array([5]) } as never, publicKey, withContext, data),
    await subtle.verify(name, publicKey, withContext, data),
  );
  const fromSpki = await subtle.importKey("spki", spki, name, true, ["verify"]);
  const fromPkcs8 = await subtle.importKey("pkcs8", pkcs8, name, true, ["sign"]);
  const fromJwk = await subtle.importKey("jwk", jwk, name, true, ["sign"]);
  console.log(name, "reimport", await subtle.verify(name, fromSpki, await subtle.sign(name, fromPkcs8, data), data), await subtle.verify(name, publicKey, await subtle.sign(name, fromJwk, data), data));
  const clone = structuredClone(privateKey);
  console.log(name, "clone", clone.type, hex(await subtle.exportKey("raw-seed", clone)).slice(0, 16));
}

const dsa = await subtle.importKey("raw-seed", new Uint8Array(32).fill(1), "ML-DSA-44", true, ["sign"]);
const dsaPublic = await subtle.getPublicKey(dsa, ["verify"]);
const dsaJwk = await subtle.exportKey("jwk", dsa);
await report("context 256", () => subtle.sign({ name: "ML-DSA-44", context: new Uint8Array(256) } as never, dsa, data));
await report("verify short", () => subtle.verify("ML-DSA-44", dsaPublic, new Uint8Array(5), data));
await report("export raw-public of private", () => subtle.exportKey("raw-public", dsa));
await report("export raw-seed of public", () => subtle.exportKey("raw-seed", dsaPublic));
await report("export raw", () => subtle.exportKey("raw", dsaPublic));
await report("export spki of private", () => subtle.exportKey("spki", dsa));
await report("import raw-public short", () => subtle.importKey("raw-public", new Uint8Array(5), "ML-DSA-44", true, ["verify"]));
await report("import raw-seed short", () => subtle.importKey("raw-seed", new Uint8Array(5), "ML-DSA-44", true, ["sign"]));
await report("import raw", () => subtle.importKey("raw", new Uint8Array(1312), "ML-DSA-44", true, ["verify"]));
await report("import spki garbage", () => subtle.importKey("spki", new Uint8Array(5), "ML-DSA-44", true, ["verify"]));
await report("import spki of 65", async () => subtle.importKey("spki", await subtle.exportKey("spki", await subtle.getPublicKey(await subtle.importKey("raw-seed", new Uint8Array(32), "ML-DSA-65", true, ["sign"]), ["verify"])), "ML-DSA-44", true, ["verify"]));
await report("import jwk wrong alg", () => subtle.importKey("jwk", { ...dsaJwk, alg: "ML-DSA-65" }, "ML-DSA-44", true, ["sign"]));
await report("import jwk no alg", () => subtle.importKey("jwk", { ...dsaJwk, alg: undefined }, "ML-DSA-44", true, ["sign"]));
await report("import jwk wrong kty", () => subtle.importKey("jwk", { ...dsaJwk, kty: "OKP" }, "ML-DSA-44", true, ["sign"]));
await report("import jwk other pub", async () => subtle.importKey("jwk", { ...dsaJwk, pub: (await subtle.exportKey("jwk", await subtle.getPublicKey(await subtle.importKey("raw-seed", new Uint8Array(32), "ML-DSA-44", true, ["sign"]), []))).pub }, "ML-DSA-44", true, ["sign"]));
await report("verify context 256", () => subtle.verify({ name: "ML-DSA-44", context: new Uint8Array(256) } as never, dsaPublic, new Uint8Array(2420), data));
for (const use of ["sig", "enc"]) {
  await report(`import jwk use ${use}`, () => subtle.importKey("jwk", { ...dsaJwk, use }, "ML-DSA-44", true, ["sign"]));
}
await report("import jwk use enc without usages", async () => subtle.importKey("jwk", { ...(await subtle.exportKey("jwk", dsaPublic)), use: "enc", key_ops: [] }, "ML-DSA-44", true, []));
await report("import jwk duplicate key_ops", () => subtle.importKey("jwk", { ...dsaJwk, key_ops: ["sign", "sign"] }, "ML-DSA-44", true, ["sign"]));
await report("import jwk key_ops mismatch", () => subtle.importKey("jwk", { ...dsaJwk, key_ops: ["verify"] }, "ML-DSA-44", true, ["sign"]));
await report("import jwk ext false", () => subtle.importKey("jwk", { ...dsaJwk, ext: false }, "ML-DSA-44", true, ["sign"]));
await report("import pkcs8 verify usage", async () => subtle.importKey("pkcs8", await subtle.exportKey("pkcs8", dsa), "ML-DSA-44", true, ["verify"]));
await report("import seed no usages", () => subtle.importKey("raw-seed", new Uint8Array(32), "ML-DSA-44", true, []));
await report("generate encrypt usage", () => subtle.generateKey("ML-DSA-65", true, ["encrypt"]));
await report("generate verify only", () => subtle.generateKey("ML-DSA-65", true, ["verify"]));
await report("generate", async () => {
  const pair = (await subtle.generateKey("ML-DSA-87", false, ["sign", "verify"])) as CryptoKeyPair;
  return [pair.privateKey.algorithm, pair.privateKey.extractable, pair.publicKey.extractable, pair.privateKey.usages, pair.publicKey.usages];
});

for (const name of ["ML-KEM-768", "ML-KEM-1024"]) {
  const seed = new Uint8Array(64).map((_, i) => 255 - i);
  const usages = ["decapsulateBits", "decapsulateKey"] as never;
  const privateKey = await subtle.importKey("raw-seed", seed, name, true, ["decapsulateBits", "decapsulateKey"] as never);
  const publicKey = await subtle.getPublicKey(privateKey, ["encapsulateBits", "encapsulateKey"] as never);
  const spki = await subtle.exportKey("spki", publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", privateKey);
  console.log(name, JSON.stringify(privateKey.algorithm), JSON.stringify(privateKey.usages), JSON.stringify(publicKey.usages));
  console.log(name, "spki", spki.byteLength, await digest(spki), "pkcs8", pkcs8.byteLength, hex(pkcs8).slice(0, 48));
  const jwk = await subtle.exportKey("jwk", privateKey);
  console.log(name, "jwk", jwk.kty, jwk.alg, (jwk.priv as string).length, (jwk.pub as string).length);
  const bits = await subtle.encapsulateBits({ name }, publicKey);
  const shared = await subtle.decapsulateBits({ name }, privateKey, bits.ciphertext);
  console.log(name, "bits", JSON.stringify(Object.keys(bits)), bits.sharedKey.byteLength, bits.ciphertext.byteLength, hex(shared) === hex(bits.sharedKey));
  const encapsulated = await subtle.encapsulateKey({ name }, publicKey, "AES-GCM", true, ["encrypt"]);
  const decapsulated = await subtle.decapsulateKey({ name }, privateKey, encapsulated.ciphertext, "AES-GCM", true, ["encrypt"]);
  console.log(name, "key", JSON.stringify(Object.keys(encapsulated)), JSON.stringify(encapsulated.sharedKey.algorithm), hex(await subtle.exportKey("raw", decapsulated)) === hex(await subtle.exportKey("raw", encapsulated.sharedKey)));
  const reimported = await subtle.importKey("pkcs8", pkcs8, name, false, usages);
  console.log(name, "reimport", reimported.type, JSON.stringify(reimported.usages));
}
const kemPair = (await subtle.generateKey("ML-KEM-768", true, ["encapsulateBits", "decapsulateBits"] as never)) as CryptoKeyPair;
await report("encapsulate with private", () => subtle.encapsulateBits("ML-KEM-768", kemPair.privateKey));
await report("decapsulate bad ciphertext", () => subtle.decapsulateBits("ML-KEM-768", kemPair.privateKey, new Uint8Array(10)));
await report("encapsulateKey without usage", () => subtle.encapsulateKey("ML-KEM-768", kemPair.publicKey, "HKDF", false, ["deriveBits"]));
await report("encapsulate wrong set", () => subtle.encapsulateBits("ML-KEM-1024", kemPair.publicKey));
// A public key whose coefficients are not reduced is refused at import, as in Bun.
const unreduced = new Uint8Array(1184).fill(0xff);
await report("import unreduced raw-public", () => subtle.importKey("raw-public", unreduced, "ML-KEM-768", true, ["encapsulateBits"] as never));
await report("import unreduced spki", async () => {
  const spki = new Uint8Array(await subtle.exportKey("spki", kemPair.publicKey));
  spki.set(unreduced, spki.length - unreduced.length);
  return subtle.importKey("spki", spki, "ML-KEM-768", true, ["encapsulateBits"] as never);
});
await report("import unreduced jwk", async () => subtle.importKey("jwk", { ...(await subtle.exportKey("jwk", kemPair.publicKey)), pub: Buffer.from(unreduced).toString("base64url") }, "ML-KEM-768", true, ["encapsulateBits"] as never));
for (const use of ["enc", "sig"]) {
  await report(`import ML-KEM jwk use ${use}`, async () => subtle.importKey("jwk", { ...(await subtle.exportKey("jwk", kemPair.publicKey)), use }, "ML-KEM-768", true, ["encapsulateBits"] as never));
}
await report("ML-KEM-512", () => subtle.generateKey("ML-KEM-512", true, ["encapsulateBits"] as never));
await report("generate sign usage", () => subtle.generateKey("ML-KEM-768", true, ["sign"]));
console.log("lengths", subtle.encapsulateBits.length, subtle.encapsulateKey.length, subtle.decapsulateBits.length, subtle.decapsulateKey.length);
