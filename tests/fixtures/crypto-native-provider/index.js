import assert from "node:assert/strict";
const key = await crypto.subtle.generateKey({name:"HMAC", hash:"SHA-256"}, false, ["sign", "verify"]);
const bytes = new Uint8Array([1,2,3]);
assert(key instanceof CryptoKey);
assert(await crypto.subtle.verify("HMAC", key, await crypto.subtle.sign("HMAC", key, bytes), bytes));
console.log("crypto provider signing works");
let rejection;
try { await crypto.subtle.importKey("raw",new Uint8Array(1),"AES-GCM",false,["encrypt"]); }
catch (error) { rejection = error; }
assert(rejection instanceof DOMException);
assert.equal(rejection.name,"DataError");
