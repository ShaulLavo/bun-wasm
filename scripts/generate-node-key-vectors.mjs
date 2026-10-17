import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
const data = Buffer.from("native encrypted key interop");
const passphrase = "fixture passphrase 🔑";
const vectors = [];
for (const kind of ["rsa", "ec"]) {
  const pair = generateKeyPairSync(
    kind,
    kind === "rsa" ? { modulusLength: 1024 } : { namedCurve: "prime256v1" },
  );
  for (const encoding of [
    { format: "pem", type: "pkcs8" },
    { format: "der", type: "pkcs8" },
    { format: "pem", type: kind === "rsa" ? "pkcs1" : "sec1" },
  ]) {
    vectors.push({
      kind,
      format: encoding.format,
      type: encoding.type,
      key: Buffer.from(
        pair.privateKey.export({
          ...encoding,
          cipher: "aes-256-cbc",
          passphrase,
        }),
      ).toString("base64url"),
      publicKey: pair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      signature: sign("sha256", data, pair.privateKey).toString("base64url"),
    });
  }
}
writeFileSync(
  new URL(
    "../tests/fixtures/node-crypto-keys/encrypted-vectors.json",
    import.meta.url,
  ),
  JSON.stringify(
    { data: data.toString("base64url"), passphrase, vectors },
    null,
    2,
  ) + "\n",
);
console.log("wrote", vectors.length, "native encrypted key vectors");
