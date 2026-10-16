import assert from "node:assert/strict";
import {createSecretKey, KeyObject, hkdfSync, pbkdf2Sync} from "node:crypto";
const bytes = Buffer.from("keyobject derivation material");
const salt = Buffer.from("salt"), info = Buffer.from("info");
for (const name of ["HKDF", "PBKDF2"]) {
  const original = createSecretKey(bytes);
  const key = original.toCryptoKey(name, false, ["deriveBits", "deriveKey"]);
  assert.equal(key.type, "secret");
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, name);
  const converted = KeyObject.from(key);
  assert.deepEqual(converted.export(), bytes);
  const roundTrip = converted.toCryptoKey(name, false, ["deriveBits"]);
  const op = {name, hash:"SHA-256", salt, info, iterations:7};
  const expected = Buffer.from(name === "HKDF" ? hkdfSync("sha256", bytes, salt, info, 32) : pbkdf2Sync(bytes, salt, 7, 32, "sha256"));
  assert.deepEqual(Buffer.from(await crypto.subtle.deriveBits(op, key, 256)), expected);
  assert.deepEqual(Buffer.from(await crypto.subtle.deriveBits(op, roundTrip, 256)), expected);
  assert.throws(() => original.toCryptoKey(name, true, ["deriveBits"]), {name:"SyntaxError"});
  assert.throws(() => original.toCryptoKey(name, false, ["sign"]), {name:"SyntaxError"});
  console.log(name, expected.toString("hex"));
}
