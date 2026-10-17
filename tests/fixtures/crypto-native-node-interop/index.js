import assert from "node:assert/strict";
import {KeyObject} from "node:crypto";
const s = crypto.subtle;
const data = new Uint8Array([1,2,3]);
const algorithm = {name:"HMAC", hash:"SHA-256", length:128};
for (const extractable of [false, true]) {
  const key = await s.generateKey(algorithm, extractable, ["sign", "verify"]);
  const object = KeyObject.from(key);
  assert.equal(object.export().length, 16);
  const back = object.toCryptoKey(algorithm, extractable, ["sign", "verify"]);
  assert.equal(back.extractable, extractable);
  const signature = await SubtleCrypto.prototype.sign.call(s, "HMAC", back, data);
  assert(await SubtleCrypto.prototype.verify.call(s, "HMAC", key, signature, data));
}
for (const name of ["HKDF", "PBKDF2"]) {
  const key = await s.importKey("raw", data, name, false, ["deriveBits"]);
  const object = KeyObject.from(key);
  assert.deepEqual(object.export(), Buffer.from(data));
  const back = object.toCryptoKey(name, false, ["deriveBits"]);
  const op = {name, hash:"SHA-256", salt:data, info:data, iterations:3};
  assert.deepEqual(
    await SubtleCrypto.prototype.deriveBits.call(s, op, back, 128),
    await SubtleCrypto.prototype.deriveBits.call(s, op, key, 128),
  );
}
console.log("native key roundtrips retain policy, material and native operations");

const material = new Uint8Array(24).fill(4);
const {createSecretKey} = await import("node:crypto");
const aes = createSecretKey(material).toCryptoKey({name:"AES-GCM"},true,["encrypt","decrypt"]);
const op = {name:"AES-GCM",iv:new Uint8Array(12)};
assert.deepEqual(new Uint8Array(await s.decrypt(op,aes,await s.encrypt(op,aes,data))),data);
assert.deepEqual(KeyObject.from(aes).export(),Buffer.from(material));
console.log("AES-192 KeyObject conversion uses native support or the verified gap");
