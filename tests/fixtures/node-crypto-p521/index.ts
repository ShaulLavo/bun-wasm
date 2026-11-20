import crypto from "node:crypto";

// P-521 (secp521r1) keys through node:crypto and WebCrypto: PEM, DER and JWK import and
// export, a JWK "d" shorter than the field, ECDSA in both signature encodings, ECDH,
// generation, and the curve's WebCrypto JWK "alg". ECDSA signatures are randomized, so
// the fixture prints their sizes and verification results.
const pkcs8 = `-----BEGIN PRIVATE KEY-----
MIHuAgEAMBAGByqGSM49AgEGBSuBBAAjBIHWMIHTAgEBBEIA+H4VL7mbakXLsG9X
H70Pym84JhUw53if4WlnJSJIBfGhyNfvp+46CrBazsrTc7xGdHVz2m4FNFUHmEMg
+zMFB/KhgYkDgYYABADZ4PUnPgT7MchjuLQm2/e8gl/IxnV9sEHWwZKmqTNchEF4
pp8C9fw4sWAmMOezFR/HMpv2Q0fVAv1n0HNKsa14KQGIgGlx7xgGDz8TtyeB3aim
j9kOjtyCgwfMhWPyVdncN8TS3xHVrzHo+1i05y2tWF+MxZzSoaavlTeJWmtfKcRv
iw==
-----END PRIVATE KEY-----
`;
// JSON with sorted object keys: key order is not part of the contract.
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
      : value;
const show = (label: string, make: () => unknown) => {
  try {
    const value = make();
    console.log(label, typeof value === "object" && value !== null && !(value instanceof Uint8Array) ? JSON.stringify(sorted(value)) : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};

const privateKey = crypto.createPrivateKey(pkcs8);
const publicKey = crypto.createPublicKey(privateKey);
const jwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
show("type", () => [privateKey.type, privateKey.asymmetricKeyType, privateKey.asymmetricKeyDetails]);
show("pkcs8 round trip", () => privateKey.export({ type: "pkcs8", format: "pem" }) === pkcs8);
show("jwk", () => jwk);
show("sec1", () => (privateKey.export({ type: "sec1", format: "der" }) as Buffer).toString("hex"));
show("spki", () => publicKey.export({ type: "spki", format: "pem" }));
show("public jwk", () => publicKey.export({ format: "jwk" }));
show("public from spki", () => crypto.createPublicKey({ key: publicKey.export({ type: "spki", format: "der" }), format: "der", type: "spki" }).equals(publicKey));
show("public from sec1", () => crypto.createPublicKey(privateKey.export({ type: "sec1", format: "pem" }) as string).equals(publicKey));

// Node and Bun accept a JWK "d" without its leading zero byte and export it padded.
const shortD = Buffer.from(jwk.d!, "base64url").subarray(1).toString("base64url");
show("short d", () => crypto.createPrivateKey({ key: { ...jwk, d: shortD }, format: "jwk" }).export({ format: "jwk" }));
show("bad point", () => crypto.createPublicKey({ key: { ...jwk, d: undefined, y: jwk.x }, format: "jwk" }));

for (const dsaEncoding of ["der", "ieee-p1363"] as const) {
  const signature = crypto.sign("sha512", Buffer.from("p521"), { key: privateKey, dsaEncoding });
  show(`sign ${dsaEncoding} size`, () => (dsaEncoding === "der" ? signature.length > 130 && signature.length < 140 : signature.length));
  show(`verify ${dsaEncoding}`, () => crypto.verify("sha512", Buffer.from("p521"), { key: publicKey, dsaEncoding }, signature));
  show(`verify ${dsaEncoding} other data`, () => crypto.verify("sha512", Buffer.from("p522"), { key: publicKey, dsaEncoding }, signature));
}
const streamed = crypto.createSign("sha256").update("stream").sign(privateKey);
show("createVerify", () => crypto.createVerify("sha256").update("stream").verify(pkcs8, streamed));

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "secp521r1" });
const generated = pair.privateKey.export({ format: "jwk" }) as JsonWebKey;
show("generated", () => [pair.privateKey.asymmetricKeyDetails, generated.crv, ...["x", "y", "d"].map(name => Buffer.from(generated[name as "x"]!, "base64url").length)]);
show("generated P-521 name", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-521" }).publicKey.asymmetricKeyDetails);
const shared = crypto.diffieHellman({ privateKey, publicKey: pair.publicKey });
show("diffieHellman", () => [shared.length, shared.equals(crypto.diffieHellman({ privateKey: pair.privateKey, publicKey }))]);
show("diffieHellman curve mismatch", () => crypto.diffieHellman({ privateKey, publicKey: crypto.generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey }));

const subtle = crypto.webcrypto.subtle;
const ecdsa = { name: "ECDSA", namedCurve: "P-521" };
const keys = (await subtle.generateKey(ecdsa, true, ["sign", "verify"])) as CryptoKeyPair;
const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-384" }, keys.privateKey, Buffer.from("webcrypto"));
console.log("webcrypto signature", signature.byteLength, await subtle.verify({ name: "ECDSA", hash: "SHA-384" }, keys.publicKey, signature, Buffer.from("webcrypto")));
const exported = await subtle.exportKey("jwk", keys.privateKey);
console.log("webcrypto jwk", exported.crv, exported.alg, JSON.stringify(exported.key_ops));
console.log("webcrypto raw", (await subtle.exportKey("raw", keys.publicKey)).byteLength, (await subtle.exportKey("spki", keys.publicKey)).byteLength);
const imported = await subtle.importKey("jwk", { ...jwk, alg: "ES512" }, ecdsa, true, ["sign"]);
console.log("webcrypto import", JSON.stringify(imported.algorithm));
await subtle.importKey("jwk", { ...jwk, alg: "ES384" }, ecdsa, true, ["sign"]).catch(error => console.log("webcrypto wrong alg", error.name, error.message));
const ecdh = { name: "ECDH", namedCurve: "P-521" };
const a = (await subtle.generateKey(ecdh, false, ["deriveBits"])) as CryptoKeyPair;
const b = (await subtle.generateKey(ecdh, false, ["deriveBits"])) as CryptoKeyPair;
const ab = await subtle.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, null);
const ba = await subtle.deriveBits({ name: "ECDH", public: a.publicKey }, b.privateKey, 528);
console.log("webcrypto ecdh", ab.byteLength, Buffer.from(ab).equals(Buffer.from(ba)));
await subtle.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 536).catch(error => console.log("webcrypto ecdh too long", error.name, error.message));
