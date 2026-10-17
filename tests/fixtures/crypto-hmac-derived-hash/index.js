import assert from "node:assert/strict";
const s = crypto.subtle;
const key = await s.importKey("raw",new Uint8Array([1]),"PBKDF2",false,["deriveBits"]);
await assert.rejects(s.deriveKey({name:"PBKDF2",hash:"SHA-256",salt:new Uint8Array([1]),iterations:1},key,{name:"HMAC",length:128},true,["sign"]),{name:"TypeError"});
console.log("HMAC derivation requires hash before deriving material");
