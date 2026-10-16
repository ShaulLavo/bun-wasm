import assert from "node:assert/strict";
const before = globalThis.__cryptoBeforeBoot;
if (before) {
  assert.equal(crypto.subtle, before.provider);
  const bytes = new Uint8Array([1,2,3]);
  const signature = await crypto.subtle.sign("HMAC", before.key, bytes);
  assert(await before.verify("HMAC", before.key, signature, bytes));
  const key = await crypto.subtle.generateKey({name:"HMAC", hash:"SHA-256"}, true, ["sign", "verify"]);
  assert(key instanceof before.Key);
  assert(await before.verify("HMAC", key, await crypto.subtle.sign("HMAC", key, bytes), bytes));
  assert(await crypto.subtle.verify("HMAC", key, await before.sign("HMAC", key, bytes), bytes));
  console.log("native provider and CryptoKeys preserved");
} else {
  const key = await crypto.subtle.generateKey({name:"HMAC", hash:"SHA-256"}, false, ["sign", "verify"]);
  const bytes = new Uint8Array([1,2,3]);
  assert(await crypto.subtle.verify("HMAC", key, await crypto.subtle.sign("HMAC", key, bytes), bytes));
  console.log("wasm provider without host SubtleCrypto");
}
