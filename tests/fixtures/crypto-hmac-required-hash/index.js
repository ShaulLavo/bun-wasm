import assert from "node:assert/strict";
for (const length of [undefined, 128]) {
  await assert.rejects(crypto.subtle.generateKey({name:"HMAC", length}, true, ["sign"]), {name:"TypeError"});
}
for (const hash of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
  const key = await crypto.subtle.generateKey({name:"HMAC", hash, length:128}, true, ["sign"]);
  assert.equal(key.algorithm.hash.name, hash);
}
console.log("HMAC requires hash with and without length");
