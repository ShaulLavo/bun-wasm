import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const s = crypto.subtle;
const data = Buffer.from("SHA-1 interoperable signatures");
const output = [];
for (const v of vectors) {
  const privateKey = await s.importKey("jwk", v.private, v.algorithm, true, ["sign"]);
  const publicKey = await s.importKey("jwk", v.public, v.algorithm, true, ["verify"]);
  assert(await s.verify(v.operation, publicKey, Buffer.from(v.signature, "base64"), data));
  const exported = await s.exportKey("jwk", privateKey);
  assert.equal(exported.alg, v.alg);
  const signature = await s.sign(v.operation, privateKey, data);
  output.push({jwk: exported, signature: Buffer.from(signature).toString("base64")});
  const a = {...v.algorithm, modulusLength:1024, publicExponent:new Uint8Array([1,0,1])};
  const pair = await s.generateKey(a, true, ["sign", "verify"]);
  assert.equal((await s.exportKey("jwk", pair.privateKey || pair)).alg, v.alg);
  console.log(v.alg, "native import, verify and export");
}
writeFileSync("produced.json", JSON.stringify(output));
