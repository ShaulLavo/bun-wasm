import assert from "node:assert/strict";
const before = globalThis.__cryptoBeforeBoot;
if (before) {
  assert.equal(crypto.subtle, before.provider);
  const originalKey = await before.key;
  const bytes = new Uint8Array([1,2,3]);
  const signature = await crypto.subtle.sign("HMAC", originalKey, bytes);
  assert(await before.verify("HMAC", originalKey, signature, bytes));
  const key = await crypto.subtle.generateKey({name:"HMAC", hash:"SHA-256"}, true, ["sign", "verify"]);
  assert(key instanceof before.Key);
  assert(await before.verify("HMAC", key, await crypto.subtle.sign("HMAC", key, bytes), bytes));
  assert(await crypto.subtle.verify("HMAC", key, await before.sign("HMAC", key, bytes), bytes));
  console.log("native provider and CryptoKeys preserved");
} else {
  const key = await crypto.subtle.generateKey({name:"HMAC", hash:"SHA-256"}, false, ["sign", "verify"]);
  const bytes = new Uint8Array([1,2,3]);
  assert(await crypto.subtle.verify("HMAC", key, await crypto.subtle.sign("HMAC", key, bytes), bytes));
  console.log("crypto provider signing works");
}
let rejection;
try { await crypto.subtle.importKey("raw",new Uint8Array(1),"AES-GCM",false,["encrypt"]); }
catch (error) { rejection = error; }
assert(rejection instanceof DOMException);
assert.equal(rejection.name,"DataError");
