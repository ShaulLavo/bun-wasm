import crypto from "node:crypto";

// KeyObject raw-public, raw-private and raw-seed formats with fixed keys, Bun's argument
// checks for them.
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
for (const namedCurve of ["secp256r1", "secp256k1", "secp224r1", "P-224", "p-256"]) {
  show(`import ec ${namedCurve}`, () => crypto.createPrivateKey({ key: ecScalar, format: "raw-private", asymmetricKeyType: "ec", namedCurve } as never).type);
}
// Generation on P-224 differs: Bun generates it, and this backend has no P-224 keys.
for (const namedCurve of ["secp256r1", "secp256k1", "p-256"]) {
  show(`generate ec ${namedCurve}`, () => crypto.generateKeyPairSync("ec", { namedCurve }).publicKey.type);
}
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

// KeyObject.export options (Node's parseKeyEncoding), sign option integers and DER decode errors.
for (const options of [undefined, null, "foo", 0, [], {}]) show(`export ${JSON.stringify(options)}`, () => rsa.publicKey.export(options as never));
show("secret export", () => crypto.createSecretKey(Buffer.alloc(4)).export());
show("secret export null", () => crypto.createSecretKey(Buffer.alloc(4)).export(null as never));
const pss = crypto.constants.RSA_PKCS1_PSS_PADDING;
for (const saltLength of [20.5, 2 ** 31, "20", null]) {
  show(`saltLength ${String(saltLength)}`, () => crypto.sign("sha256", Buffer.from("x"), { key: rsa.privateKey, padding: pss, saltLength } as never));
}
for (const padding of [6.5, "6", 2 ** 32]) show(`padding ${String(padding)}`, () => crypto.sign("sha256", Buffer.from("x"), { key: rsa.privateKey, padding } as never));
show("pkcs1 public as private", () => crypto.createPrivateKey({ key: rsa.publicKey.export({ format: "der", type: "pkcs1" }), format: "der", type: "pkcs1" }));
show("pkcs8 garbage", () => crypto.createPrivateKey({ key: Buffer.alloc(10), format: "der", type: "pkcs8" }));

