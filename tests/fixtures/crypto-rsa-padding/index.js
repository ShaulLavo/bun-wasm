import assert from "node:assert/strict";
import {generateKeyPairSync, sign, verify, createSign, createVerify, constants} from "node:crypto";
const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength:1024});
const bytes = Buffer.from("RSA padding validation");
const signature = sign("sha256", bytes, privateKey);
assert(verify("sha256", bytes, publicKey, signature));
for (const padding of [constants.RSA_NO_PADDING, constants.RSA_PKCS1_OAEP_PADDING, 999]) {
  for (const operation of ["sign", "verify", "createSign", "createVerify"]) {
    assert.throws(() => {
      if (operation === "sign") return sign("sha256", bytes, {key:privateKey, padding});
      if (operation === "verify") return verify("sha256", bytes, {key:publicKey, padding}, signature);
      if (operation === "createSign") return createSign("sha256").update(bytes).sign({key:privateKey, padding});
      return createVerify("sha256").update(bytes).verify({key:publicKey, padding}, signature);
    }, error => /ERR_OSSL_(EVP_)?(INVALID_PADDING_MODE|ILLEGAL_OR_UNSUPPORTED_PADDING_MODE)/.test(error.code));
  }
  console.log("rejected padding", padding, "for sign and verify, one-shot and stream");
}
for (const padding of [constants.RSA_PKCS1_PADDING, constants.RSA_PKCS1_PSS_PADDING]) {
  const sig = sign("sha256", bytes, {key:privateKey, padding, saltLength:32});
  assert(verify("sha256", bytes, {key:publicKey, padding, saltLength:32}, sig));
  console.log("accepted padding", padding);
}
