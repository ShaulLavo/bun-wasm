import assert from "node:assert/strict";
const s = crypto.subtle;
const data = new Uint8Array([1,2,3]);
const equal = (a,b) => assert.deepEqual(new Uint8Array(a),new Uint8Array(b));
const wrap = await s.generateKey({name:"AES-GCM",length:256},false,["wrapKey","unwrapKey"]);
const wrapOp = {name:"AES-GCM",iv:new Uint8Array(12)};
const secretBytes = new Uint8Array(16).fill(7);
const secret = await s.importKey("raw",secretBytes,{name:"HMAC",hash:"SHA-256"},true,["sign"]);
for (const name of ["AES-GCM","AES-CBC","AES-CTR","AES-KW"]) {
  const usages = name === "AES-KW" ? ["wrapKey","unwrapKey"] : ["encrypt","decrypt","wrapKey","unwrapKey"];
  const key = await s.generateKey({name,length:192},true,usages);
  assert(key instanceof CryptoKey);
  const raw = await s.exportKey("raw",key);
  assert.equal(raw.byteLength,24);
  const imported = await s.importKey("jwk",await s.exportKey("jwk",key),{name},true,usages);
  equal(await s.exportKey("raw",imported),raw);
  const op = {name,iv:new Uint8Array(name === "AES-GCM" ? 12 : 16),counter:new Uint8Array(16),length:64};
  if (name !== "AES-KW") {
    const input = data.slice();
    const pending = s.encrypt(op,key,input);
    input[0] = 99;
    equal(await s.decrypt(op,key,await pending),data);
  }
  for (const format of ["raw","jwk"]) {
    const wrapped = await s.wrapKey(format,key,wrap,wrapOp);
    const back = await s.unwrapKey(format,wrapped,wrap,wrapOp,{name},true,usages);
    equal(await s.exportKey("raw",back),raw);
    const encrypted = await s.wrapKey(format,secret,key,op);
    const unwrapped = await s.unwrapKey(format,encrypted,key,op,{name:"HMAC",hash:"SHA-256"},true,["sign"]);
    equal(await s.exportKey("raw",unwrapped),secretBytes);
  }
  console.log(name,"192 native/fallback and mixed wrapping");
}
const base = await s.importKey("raw",data,"PBKDF2",false,["deriveKey"]);
const derived = await s.deriveKey({name:"PBKDF2",hash:"SHA-256",iterations:7,salt:data},base,{name:"AES-GCM",length:192},true,["encrypt"]);
assert.equal(Buffer.from(await s.exportKey("raw",derived)).toString("hex"),"790bd2058ae9c386a10789520038e1a0ce8e65de42c1d28b");
console.log("AES 192 deriveKey-only base usage");

const kw = await s.generateKey({name:"AES-KW",length:128},false,["wrapKey","unwrapKey"]);
const wrappedJwk = await s.wrapKey("jwk",secret,kw,{name:"AES-KW"});
const plainJwk = await s.unwrapKey("jwk",wrappedJwk,kw,{name:"AES-KW"},{name:"HMAC",hash:"SHA-256"},true,["sign"]);
equal(await s.exportKey("raw",plainJwk),secretBytes);
console.log("native AES-KW JWK alignment gap");
