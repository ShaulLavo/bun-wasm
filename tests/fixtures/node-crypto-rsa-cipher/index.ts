import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt with each padding mode, as
// Bun runs them. A fixed 1024-bit key makes the PKCS#1 v1.5 and raw results deterministic.
const { constants } = crypto;
const pem = readFileSync(new URL("key.pem", import.meta.url), "utf8");
const privateKey = crypto.createPrivateKey(pem);
const publicKey = crypto.createPublicKey(pem);
const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
const privateDer = privateKey.export({ format: "der", type: "pkcs1" });
const publicDer = publicKey.export({ format: "der", type: "pkcs1" });
const message = Buffer.from("RSA cipher fixture");
const digest = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);

const show = (label: string, run: () => unknown) => {
  try {
    const value = run();
    console.log(label, value instanceof Uint8Array ? `${value.length} ${digest(value)}` : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code);
  }
};

// privateEncrypt and publicDecrypt default to PKCS#1 v1.5, which is deterministic.
const signed = crypto.privateEncrypt(privateKey, message);
show("privateEncrypt default", () => signed);
show("privateEncrypt pkcs1 pem", () => crypto.privateEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, message));
show("publicDecrypt public", () => String(crypto.publicDecrypt(publicKey, signed)));
show("publicDecrypt public pem", () => String(crypto.publicDecrypt(publicPem, signed)));
show("publicDecrypt private", () => String(crypto.publicDecrypt(privateKey, signed)));
show("publicDecrypt pkcs1 der", () => String(crypto.publicDecrypt({ key: publicDer, format: "der", type: "pkcs1" }, signed)));
show("publicDecrypt hex key", () => String(crypto.publicDecrypt({ key: Buffer.from(publicPem).toString("hex"), encoding: "hex" } as never, signed)));
const pemBytes = new TextEncoder().encode(publicPem);
show("publicDecrypt DataView key", () => String(crypto.publicDecrypt(new DataView(pemBytes.buffer) as never, new DataView(signed.buffer, signed.byteOffset, signed.length) as never)));
const certificate = readFileSync(new URL("cert.pem", import.meta.url), "utf8");
show("publicDecrypt certificate", () => String(crypto.publicDecrypt(certificate, signed)));
show("publicEncrypt certificate", () => String(crypto.privateDecrypt(privateKey, crypto.publicEncrypt(certificate, message))));
show("createPublicKey certificate", () => crypto.createPublicKey(certificate).equals(publicKey));
show("publicDecrypt tampered", () => crypto.publicDecrypt(publicKey, Buffer.from(signed).fill(1, 0, 8)));
show("privateEncrypt too long", () => crypto.privateEncrypt(privateKey, Buffer.alloc(128, 1)));

// Raw RSA needs input of exactly the modulus size.
const block = Buffer.alloc(128, 3);
block[0] = 0;
const rawSigned = crypto.privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, block);
show("privateEncrypt none", () => rawSigned);
show("publicDecrypt none", () => crypto.publicDecrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, rawSigned).equals(block));
const rawSealed = crypto.publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, block);
show("publicEncrypt none", () => rawSealed);
show("privateDecrypt none", () => crypto.privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, rawSealed).equals(block));
show("publicEncrypt none short", () => crypto.publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, message));

// PKCS#1 v1.5 encryption works; Bun refuses PKCS#1 v1.5 private decryption.
const pkcs1Sealed = crypto.publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, message);
show("publicEncrypt pkcs1 length", () => pkcs1Sealed.length);
show("privateDecrypt pkcs1", () => crypto.privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, pkcs1Sealed));

// publicEncrypt and privateDecrypt default to OAEP with SHA-1.
show("oaep default", () => String(crypto.privateDecrypt(privateKey, crypto.publicEncrypt(publicKey, message))));
const oaep = { oaepHash: "sha256", oaepLabel: Buffer.from("label") };
show("oaep sha256 label", () => String(crypto.privateDecrypt({ key: privateKey, ...oaep }, crypto.publicEncrypt({ key: publicKey, ...oaep }, message))));
show("oaep hash mismatch", () => crypto.privateDecrypt({ key: privateKey, oaepHash: "sha512" }, crypto.publicEncrypt({ key: publicKey, oaepHash: "sha256" }, message)));
show("oaep bad hash", () => crypto.publicEncrypt({ key: publicKey, oaepHash: "nope" }, message));
show("oaep hash type", () => crypto.publicEncrypt({ key: publicKey, oaepHash: 1 } as never, message));
show("oaep label type", () => crypto.publicEncrypt({ key: publicKey, oaepLabel: {} } as never, message));
show("data type", () => crypto.publicEncrypt(publicKey, 1 as never));

// Node tells PKCS#1 public and private DER apart from the bytes alone.
for (const [label, key] of [["public", publicDer], ["private", privateDer]] as const) {
  show(`publicEncrypt pkcs1 der ${label}`, () => String(crypto.privateDecrypt(privateKey, crypto.publicEncrypt({ key, format: "der", type: "pkcs1" }, message))));
}

// The cipher options are read once each, in Bun's order, before the key.
const reads: string[] = [];
const watched = { key: publicKey } as Record<string, unknown>;
for (const name of ["oaepLabel", "oaepHash", "padding"]) {
  Object.defineProperty(watched, name, { get: () => void reads.push(name) });
}
show("read order", () => (crypto.publicEncrypt(watched as never, message), reads.join(" ")));

// The same with the error's message, which Bun takes from BoringSSL or its own checks.
const detail = (label: string, run: () => unknown) => {
  try {
    console.log(label, String(run()));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};

// OAEP options apply as given: under another padding, BoringSSL refuses them.
detail("privateEncrypt oaepHash", () => crypto.privateEncrypt({ key: privateKey, oaepHash: "sha256" } as never, message).length);
detail("publicDecrypt oaepHash", () => crypto.publicDecrypt({ key: publicKey, oaepHash: "sha256" } as never, signed).length);
detail("privateEncrypt oaepLabel", () => crypto.privateEncrypt({ key: privateKey, oaepLabel: Buffer.from("a") } as never, message).length);
detail("publicEncrypt none label", () => crypto.publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING, oaepLabel: Buffer.from("a") }, block).length);
detail("publicEncrypt none empty label", () => crypto.publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING, oaepLabel: Buffer.alloc(0) }, block).length);
detail("publicEncrypt pkcs1 oaepHash", () => crypto.publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING, oaepHash: "sha1" }, message).length);
detail("padding 999", () => crypto.publicEncrypt({ key: publicKey, padding: 999 }, message).length);

// The padding is converted as JSValue::toInt32 does: ToNumber, then int32.
for (const [label, padding] of [["string", "3"], ["object", { valueOf: () => 3 }], ["fraction", 3.9], ["bigint", 3n], ["symbol", Symbol("padding")]] as const) {
  show(`padding ${label}`, () => crypto.publicEncrypt({ key: publicKey, padding } as never, block).length);
}

// OAEP digests use Bun's digest names (ncrypto's Digest::FromName).
for (const name of ["sha512-224", "sha512-256", "md4", "MD5", "SHA256", "sha-256", "RSA-SHA256", "sha3-256", "md5-sha1", "ripemd160", "sha256WithRSAEncryption", "sha128", "dss1", "SHA-512/224", "shake128", "blake2b512"]) {
  detail(`oaepHash ${name}`, () => {
    const sealed = crypto.publicEncrypt({ key: publicKey, oaepHash: name }, message);
    return String(crypto.privateDecrypt({ key: privateKey, oaepHash: name }, sealed));
  });
}

// PEM input with several blocks: a public operation takes a public key, then PKCS#1 public,
// then a certificate, then a private key; a private operation takes the first private key.
const pemB = readFileSync(new URL("keyB.pem", import.meta.url), "utf8");
const publicPemB = crypto.createPublicKey(pemB).export({ format: "pem", type: "spki" }) as string;
const encryptedA = readFileSync(new URL("encA.pem", import.meta.url), "utf8");
const encryptedA8 = readFileSync(new URL("encA8.pem", import.meta.url), "utf8");
const owner = (sealed: Buffer) => {
  for (const [name, key] of [["A", pem], ["B", pemB]]) {
    try {
      crypto.privateDecrypt(key, sealed);
      return name;
    } catch {}
  }
  return "neither";
};
const mixed = {
  "certificate A, public B": certificate + publicPemB,
  "public B, certificate A": publicPemB + certificate,
  "private A, public B": pem + publicPemB,
  "private B, certificate A": pemB + certificate,
  "certificate A, private B": certificate + pemB,
  "encrypted A, public B": encryptedA + publicPemB,
  "encrypted PKCS#8 A, public B": encryptedA8 + publicPemB,
};
for (const [label, input] of Object.entries(mixed)) detail(`publicEncrypt ${label}`, () => owner(crypto.publicEncrypt(input, message)));
detail("createPublicKey certificate A, public B", () => crypto.createPublicKey(mixed["certificate A, public B"]).equals(crypto.createPublicKey(publicPemB)));
detail("createPrivateKey certificate A, private B", () => crypto.createPrivateKey(certificate + pemB).equals(crypto.createPrivateKey(pemB)));
detail("createPrivateKey public B, private A", () => crypto.createPrivateKey(publicPemB + pem).equals(privateKey));
detail("privateDecrypt certificate A, private B", () => String(crypto.privateDecrypt(certificate + pemB, crypto.publicEncrypt(publicPemB, message))));
detail("privateDecrypt public B", () => crypto.privateDecrypt(publicPemB, message));
detail("createPrivateKey certificate", () => crypto.createPrivateKey(certificate));
detail("createPublicKey not PEM", () => crypto.createPublicKey("not a key"));
detail("publicEncrypt not PEM", () => crypto.publicEncrypt("not a key", message));

// Encrypted private keys.
for (const [label, input] of [["PEM", encryptedA], ["PKCS#8", encryptedA8]] as const) {
  detail(`${label} no passphrase`, () => crypto.privateDecrypt(input, message));
  detail(`${label} wrong passphrase`, () => crypto.privateDecrypt({ key: input, passphrase: "wrong" }, message));
  detail(`${label} passphrase`, () => owner(crypto.publicEncrypt({ key: input, passphrase: "secret" }, message)));
  detail(`${label} createPrivateKey wrong passphrase`, () => crypto.createPrivateKey({ key: input, passphrase: Buffer.from("wrong") }));
}
detail("publicEncrypt encrypted no passphrase", () => crypto.publicEncrypt(encryptedA, message));

// Key objects of the wrong type.
const secret = crypto.createSecretKey(Buffer.alloc(16));
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
detail("privateEncrypt public KeyObject", () => crypto.privateEncrypt(publicKey, message));
detail("privateDecrypt public KeyObject", () => crypto.privateDecrypt(publicKey, message));
detail("publicEncrypt secret KeyObject", () => crypto.publicEncrypt(secret, message));
detail("privateEncrypt secret KeyObject", () => crypto.privateEncrypt(secret, message));
detail("createPublicKey secret KeyObject", () => crypto.createPublicKey(secret as never));
detail("sign public KeyObject", () => crypto.sign("sha256", message, publicKey));
detail("verify secret KeyObject", () => crypto.verify("sha256", message, secret, Buffer.alloc(1)));
detail("publicEncrypt EC", () => crypto.publicEncrypt(ec.publicKey, message));
detail("privateEncrypt EC", () => crypto.privateEncrypt(ec.privateKey, message));
