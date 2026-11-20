import crypto from "node:crypto";

// KeyObject raw-public, raw-private and raw-seed formats with fixed keys, Bun's argument
// checks for them, and SubtleCrypto.getPublicKey for the classic key types.
const show = (label: string, make: () => unknown) => {
  try {
    const value = make();
    console.log(label, value instanceof Uint8Array ? Buffer.from(value).toString("hex") : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};
const seed = Buffer.alloc(32, 7);
const ecScalar = Buffer.alloc(32, 9);
const sources = [
  ["ed25519", undefined, seed],
  ["x25519", undefined, seed],
  ["ec", "P-256", ecScalar],
  ["ec", "prime256v1", ecScalar],
  ["ec", "P-384", Buffer.alloc(48, 9)],
  ["ec", "secp521r1", Buffer.concat([Buffer.alloc(1), Buffer.alloc(65, 9)])],
] as const;
for (const [asymmetricKeyType, namedCurve, raw] of sources) {
  const label = `${asymmetricKeyType} ${namedCurve ?? ""}`;
  const options = { key: raw, format: "raw-private", asymmetricKeyType, ...(namedCurve ? { namedCurve } : {}) } as const;
  show(`${label} import`, () => {
    const privateKey = crypto.createPrivateKey(options as never);
    const publicKey = crypto.createPublicKey(options as never);
    const rawPublic = publicKey.export({ format: "raw-public" } as never) as Buffer;
    const back = crypto.createPublicKey({ ...options, key: rawPublic, format: "raw-public" } as never);
    return [
      privateKey.type,
      publicKey.type,
      privateKey.asymmetricKeyType,
      JSON.stringify(privateKey.asymmetricKeyDetails),
      (privateKey.export({ format: "raw-private" } as never) as Buffer).equals(raw),
      rawPublic.toString("hex").slice(0, 20),
      rawPublic.length,
      (privateKey.export({ format: "raw-public" } as never) as Buffer).equals(rawPublic),
      back.equals(publicKey),
    ].join(" ");
  });
  if (asymmetricKeyType !== "ec") continue;
  show(`${label} compressed`, () => {
    const publicKey = crypto.createPublicKey(options as never);
    const compressed = publicKey.export({ format: "raw-public", type: "compressed" } as never) as Buffer;
    const back = crypto.createPublicKey({ ...options, key: compressed, format: "raw-public" } as never);
    return `${compressed.length} ${compressed[0] <= 3} ${back.equals(publicKey)}`;
  });
}

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const ed = crypto.generateKeyPairSync("ed25519");
const ec = crypto.createPrivateKey({ key: ecScalar, format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" } as never);
show("rsa raw-public", () => rsa.publicKey.export({ format: "raw-public" } as never));
show("rsa raw-private", () => rsa.privateKey.export({ format: "raw-private" } as never));
show("ed raw-seed", () => ed.privateKey.export({ format: "raw-seed" } as never));
show("ed public raw-private", () => ed.publicKey.export({ format: "raw-private" } as never));
show("ed raw-private passphrase", () => ed.privateKey.export({ format: "raw-private", passphrase: "x" } as never));
show("ec raw-public bad type", () => ec.export({ format: "raw-public", type: "hybrid" } as never));
show("import rsa", () => crypto.createPrivateKey({ key: Buffer.alloc(32), format: "raw-private", asymmetricKeyType: "rsa" } as never));
show("import banana", () => crypto.createPrivateKey({ key: Buffer.alloc(32), format: "raw-private", asymmetricKeyType: "banana" } as never));
show("import ec no curve", () => crypto.createPublicKey({ key: Buffer.alloc(32), format: "raw-public", asymmetricKeyType: "ec" } as never));
show("import ec bad curve", () => crypto.createPrivateKey({ key: ecScalar, format: "raw-private", asymmetricKeyType: "ec", namedCurve: "no-such-curve" } as never));
show("import ec short scalar", () => crypto.createPrivateKey({ key: Buffer.alloc(31, 1), format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" } as never));
show("import ec bad point", () => crypto.createPublicKey({ key: Buffer.alloc(65, 4), format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" } as never));
show("import private from raw-public", () => crypto.createPrivateKey({ key: seed, format: "raw-public", asymmetricKeyType: "ed25519" } as never));
show("import string", () => crypto.createPrivateKey({ key: "not a buffer", format: "raw-private", asymmetricKeyType: "ed25519" } as never));
show("import ed raw-seed", () => crypto.createPrivateKey({ key: seed, format: "raw-seed", asymmetricKeyType: "ed25519" } as never));
show("import ed short", () => crypto.createPublicKey({ key: Buffer.alloc(31), format: "raw-public", asymmetricKeyType: "ed25519" } as never));
show("keygen raw encodings", () => {
  const pair = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "raw-public" },
    privateKeyEncoding: { format: "raw-private" },
  } as never) as unknown as { publicKey: Buffer; privateKey: Buffer };
  return `${pair.publicKey.length} ${pair.privateKey.length}`;
});
show("keygen compressed", () => (crypto.generateKeyPairSync("ec", { namedCurve: "P-384", publicKeyEncoding: { format: "raw-public", type: "compressed" } } as never).publicKey as unknown as Buffer).length);
show("keygen bad type", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { format: "raw-public", type: "garbage" } } as never));
show("keygen raw cipher", () => crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { format: "raw-private", cipher: "aes-128-cbc", passphrase: "secret" } } as never));
show("keygen raw passphrase", () => crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { format: "raw-private", passphrase: "secret" } } as never));

const subtle = crypto.webcrypto.subtle;
const algorithms = [
  [{ name: "ECDSA", namedCurve: "P-256" }, ["sign", "verify"], ["verify"]],
  [{ name: "ECDH", namedCurve: "P-384" }, ["deriveBits"], []],
  ["Ed25519", ["sign", "verify"], ["verify"]],
  ["X25519", ["deriveBits"], []],
  [{ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, ["sign", "verify"], ["verify"]],
  [{ name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, ["decrypt", "encrypt"], ["encrypt"]],
] as const;
for (const [algorithm, usages, publicUsages] of algorithms) {
  const pair = (await subtle.generateKey(algorithm as never, false, usages as never)) as CryptoKeyPair;
  const label = typeof algorithm === "string" ? algorithm : algorithm.name;
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
