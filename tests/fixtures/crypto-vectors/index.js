import vectors from "./vectors.json";
import assert from "node:assert/strict";
const s = crypto.subtle;
const decode = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const encoded = (b) => Buffer.from(b).toString("base64url");
const data = decode(vectors.data);
for (const v of vectors.sign) {
  const publicKey = await s.importKey("jwk", v.public, v.algorithm, true, [
    "verify",
  ]);
  assert(await s.verify(v.operation, publicKey, decode(v.signature), data));
  const privateKey = await s.importKey("jwk", v.private, v.algorithm, true, [
    "sign",
  ]);
  assert(
    await s.verify(
      v.operation,
      publicKey,
      await s.sign(v.operation, privateKey, data),
      data,
    ),
  );
  if (v.pkcs8) {
    const privateDer = await s.importKey(
      "pkcs8",
      decode(v.pkcs8),
      v.algorithm,
      true,
      ["sign"],
    );
    const publicDer = await s.importKey(
      "spki",
      decode(v.spki),
      v.algorithm,
      true,
      ["verify"],
    );
    assert(
      await s.verify(
        v.operation,
        publicDer,
        await s.sign(v.operation, privateDer, data),
        data,
      ),
    );
    assert.equal(encoded(await s.exportKey("spki", publicDer)), v.spki);
  }
}
console.log("native signatures", vectors.sign.length);
for (const v of vectors.encrypt) {
  const op = { ...v.operation };
  for (const name of ["iv", "counter", "additionalData", "label"])
    if (op[name] !== undefined) op[name] = decode(op[name]);
  const key = await s.importKey("jwk", v.private || v.key, v.algorithm, true, [
    "decrypt",
  ]);
  assert.equal(
    encoded(await s.decrypt(op, key, decode(v.ciphertext))),
    vectors.data,
  );
  if (v.public) continue;
  const encryptionKey = await s.importKey("jwk", v.key, v.algorithm, true, [
    "encrypt",
  ]);
  assert.equal(encoded(await s.encrypt(op, encryptionKey, data)), v.ciphertext);
}
console.log("native ciphers", vectors.encrypt.length);
for (const v of vectors.derive) {
  const op = { ...v.operation, salt: decode(v.operation.salt) };
  if (op.info) op.info = decode(op.info);
  const key = await s.importKey("raw", data, op.name, false, ["deriveBits"]);
  assert.equal(encoded(await s.deriveBits(op, key, 256)), v.bits);
}
console.log("native derivations", vectors.derive.length);
for (const v of vectors.agree) {
  const priv = await s.importKey("jwk", v.private, v.algorithm, false, [
    "deriveBits",
  ]);
  const pub = await s.importKey("jwk", v.public, v.algorithm, false, []);
  assert.equal(
    encoded(await s.deriveBits({ ...v.algorithm, public: pub }, priv, 256)),
    v.bits,
  );
}
console.log("native agreements", vectors.agree.length);
