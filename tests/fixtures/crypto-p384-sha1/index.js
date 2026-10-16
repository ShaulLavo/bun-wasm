import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
const v = JSON.parse(readFileSync(new URL("./vector.json", import.meta.url), "utf8"));
const s = crypto.subtle;
const a = {name:"ECDSA", namedCurve:"P-384"};
const op = {name:"ECDSA", hash:"SHA-1"};
const data = Buffer.from("P-384 SHA-1 interoperable signature");
const privateKey = await s.importKey("jwk", v.private, a, true, ["sign"]);
const publicKey = await s.importKey("jwk", v.public, a, true, ["verify"]);
const verified = await s.verify(op, publicKey, Buffer.from(v.signature, "base64"), data);
console.log("P-384 SHA-1 native verify", verified);
let signature;
try { signature = await s.sign(op, privateKey, data); }
catch (error) { console.log("P-384 SHA-1 runtime sign FAIL", error.name); }
assert(verified);
assert(signature);
assert(await s.verify(op, publicKey, signature, data));
writeFileSync("produced.json", JSON.stringify({jwk:await s.exportKey("jwk", privateKey), signature:Buffer.from(signature).toString("base64")}));
console.log("P-384 SHA-1 runtime sign ok");
