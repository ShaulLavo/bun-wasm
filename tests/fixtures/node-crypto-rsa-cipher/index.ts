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
