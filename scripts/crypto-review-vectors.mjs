import {webcrypto} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import assert from "node:assert/strict";
const s = webcrypto.subtle;
const root = new URL("../tests/fixtures/", import.meta.url);
const b64 = data => Buffer.from(data).toString("base64");
if (process.argv[2] === "--generate") {
  const vectors = [];
  for (const [name, alg] of [["HMAC", "HS1"], ["RSASSA-PKCS1-v1_5", "RS1"], ["RSA-PSS", "PS1"]]) {
    const algorithm = {name, hash:"SHA-1"};
    const pair = await s.generateKey({...algorithm, modulusLength:1024, publicExponent:new Uint8Array([1,0,1])}, true, ["sign", "verify"]);
    const operation = {...algorithm, saltLength:20};
    vectors.push({algorithm, operation, alg,
      private:await s.exportKey("jwk", pair.privateKey || pair),
      public:await s.exportKey("jwk", pair.publicKey || pair),
      signature:b64(await s.sign(operation, pair.privateKey || pair, Buffer.from("SHA-1 interoperable signatures")))});
  }
  writeFileSync(new URL("crypto-sha1-jwk/vectors.json", root), JSON.stringify(vectors, null, 2) + "\n");
  const pair = await s.generateKey({name:"ECDSA", namedCurve:"P-384"}, true, ["sign", "verify"]);
  writeFileSync(new URL("crypto-p384-sha1/vector.json", root), JSON.stringify({
    private:await s.exportKey("jwk", pair.privateKey), public:await s.exportKey("jwk", pair.publicKey),
    signature:b64(await s.sign({name:"ECDSA", hash:"SHA-1"}, pair.privateKey, Buffer.from("P-384 SHA-1 interoperable signature")))}, null, 2) + "\n");
} else {
  const [name, output] = process.argv.slice(2);
  const produced = JSON.parse(readFileSync(output, "utf8"));
  if (name === "crypto-sha1-jwk") {
    const vectors = JSON.parse(readFileSync(new URL(`${name}/vectors.json`, root), "utf8"));
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i], row = produced[i];
      const key = await s.importKey("jwk", row.jwk, v.algorithm, true, ["sign"]);
      const pub = await s.importKey("jwk", v.public, v.algorithm, true, ["verify"]);
      assert(await s.verify(v.operation, pub, Buffer.from(row.signature, "base64"), Buffer.from("SHA-1 interoperable signatures")));
      assert.equal((await s.exportKey("jwk", key)).alg, v.alg);
    }
    console.log("native accepted 3 runtime JWKs and signatures");
  } else if (name === "crypto-p384-sha1") {
    const v = JSON.parse(readFileSync(new URL(`${name}/vector.json`, root), "utf8"));
    const key = await s.importKey("jwk", v.public, {name:"ECDSA", namedCurve:"P-384"}, true, ["verify"]);
    assert(await s.verify({name:"ECDSA", hash:"SHA-1"}, key, Buffer.from(produced.signature, "base64"), Buffer.from("P-384 SHA-1 interoperable signature")));
    console.log("native accepted runtime P-384 SHA-1 signature");
  } else throw new Error("Expected fixture name and produced.json path, or --generate");
}
