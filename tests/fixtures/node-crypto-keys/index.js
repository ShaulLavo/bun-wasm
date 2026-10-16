import assert from "node:assert/strict";
import { types } from "node:util";
import {
  generateKeySync,
  generateKey,
  generateKeyPairSync,
  generateKeyPair,
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  createSign,
  createVerify,
  sign,
  verify,
  createHmac,
  pbkdf2Sync,
  hkdfSync,
  constants,
} from "node:crypto";
const input = Buffer.from("node crypto keys");
for (const [type, options] of [
  ["rsa", { modulusLength: 1024 }],
  ["ec", { namedCurve: "prime256v1" }],
  ["ec", { namedCurve: "secp384r1" }],
  ["ed25519", {}],
]) {
  const { privateKey, publicKey } = generateKeyPairSync(type, options);
  assert(privateKey instanceof KeyObject);
  assert(types.isKeyObject(publicKey));
  assert.equal(privateKey.type, "private");
  assert.equal(publicKey.type, "public");
  assert.equal(publicKey.asymmetricKeyType, type);
  const digest = type === "ed25519" ? null : "sha256";
  const sig = sign(digest, input, privateKey);
  assert(verify(digest, input, publicKey, sig));
  assert(!verify(digest, Buffer.from("wrong"), publicKey, sig));
  const privateJwk = privateKey.export({ format: "jwk" }),
    publicJwk = publicKey.export({ format: "jwk" });
  const importedPrivate = createPrivateKey({ key: privateJwk, format: "jwk" });
  const importedPublic = createPublicKey({ key: publicJwk, format: "jwk" });
  assert(
    verify(digest, input, importedPublic, sign(digest, input, importedPrivate)),
  );
  for (const encoding of ["pem", "der"]) {
    const pri = privateKey.export({ format: encoding, type: "pkcs8" }),
      pub = publicKey.export({ format: encoding, type: "spki" });
    assert(
      verify(
        digest,
        input,
        createPublicKey({ key: pub, format: encoding, type: "spki" }),
        sign(
          digest,
          input,
          createPrivateKey({ key: pri, format: encoding, type: "pkcs8" }),
        ),
      ),
    );
  }
  const webAlgorithm =
    type === "rsa"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : type === "ec"
        ? {
            name: "ECDSA",
            namedCurve: options.namedCurve === "prime256v1" ? "P-256" : "P-384",
          }
        : { name: "Ed25519" };
  const webKey = privateKey.toCryptoKey(webAlgorithm, true, ["sign"]);
  const webOp =
    type === "ec" ? { name: "ECDSA", hash: "SHA-256" } : webAlgorithm;
  const webSig = await crypto.subtle.sign(webOp, webKey, input);
  const nodeOptions =
    type === "ec" ? { key: publicKey, dsaEncoding: "ieee-p1363" } : publicKey;
  assert(verify(digest, input, nodeOptions, new Uint8Array(webSig)));
  assert(
    verify(
      digest,
      input,
      publicKey,
      sign(digest, input, KeyObject.from(webKey)),
    ),
  );
  if (type === "rsa") {
    const pss = {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    };
    assert(
      verify(
        "sha256",
        input,
        { ...pss, key: publicKey },
        sign("sha256", input, pss),
      ),
    );
    const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" });
    assert(
      verify(digest, input, createPublicKey(pkcs1), sign(digest, input, pkcs1)),
    );
  }
  if (type === "ec") {
    const sec1 = privateKey.export({ format: "der", type: "sec1" });
    assert(
      verify(
        digest,
        input,
        publicKey,
        sign(digest, input, { key: sec1, format: "der", type: "sec1" }),
      ),
    );
  }
  if (type !== "ed25519") {
    const signature = createSign("SHA256")
      .update(input.subarray(0, 3))
      .update(input.subarray(3))
      .sign(privateKey, "base64");
    assert(
      createVerify("SHA256")
        .update(input)
        .verify(publicKey, signature, "base64"),
    );
  }
  console.log("node keys", type, options.namedCurve || "ok");
}
const secret = createSecretKey(input);
assert.equal(secret.symmetricKeySize, input.length);
assert(secret.equals(createSecretKey(input)));
const webSecret = secret.toCryptoKey({ name: "HMAC", hash: "SHA-256" }, false, [
  "sign",
]);
assert.equal(
  createHmac("sha256", webSecret).update(input).digest("hex"),
  Buffer.from(await crypto.subtle.sign("HMAC", webSecret, input)).toString(
    "hex",
  ),
);
assert.equal(KeyObject.from(webSecret).export().toString(), input.toString());
assert.equal(
  pbkdf2Sync("password", "salt", 1, 32, "sha256").toString("hex"),
  "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
);
assert.equal(hkdfSync("sha256", "input", "salt", "info", 0).byteLength, 0);
await new Promise((resolve, reject) =>
  generateKeyPair("ed25519", {}, (err, pub, priv) => {
    if (err) return reject(err);
    assert(verify(null, input, pub, sign(null, input, priv)));
    resolve();
  }),
);
console.log("node interop ok");
for (const algorithm of [
  {
    name: "RSA-PSS",
    modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  { name: "ECDH", namedCurve: "P-256" },
]) {
  const pair = await crypto.subtle.generateKey(
    algorithm,
    true,
    algorithm.name === "ECDH" ? ["deriveBits"] : ["sign", "verify"],
  );
  const privateKey = KeyObject.from(pair.privateKey),
    publicKey = KeyObject.from(pair.publicKey);
  assert.equal(
    privateKey.asymmetricKeyType,
    algorithm.name === "ECDH" ? "ec" : "rsa",
  );
  assert(verify("sha256", input, publicKey, sign("sha256", input, privateKey)));
}
console.log("node key purposes ok");

const pssPair = await crypto.subtle.generateKey(
  {
    name: "RSA-PSS",
    modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const pssJwk = await crypto.subtle.exportKey("jwk", pssPair.privateKey);
assert.equal(
  createPrivateKey({
    key: { ...pssJwk, ext: false, key_ops: [] },
    format: "jwk",
  }).asymmetricKeyType,
  "rsa",
);
console.log("node JWK metadata ok");

const ed = generateKeyPairSync("ed25519");
assert.throws(() => sign("sha256", input, ed.privateKey), {
  code: "ERR_OSSL_EVP_COMMAND_NOT_SUPPORTED",
});
console.log("node digest validation ok");

assert.throws(
  () =>
    generateKeyPairSync("rsa", {
      modulusLength: 512,
      publicExponent: 4294967299,
    }),
  { code: "ERR_OUT_OF_RANGE" },
);
console.log("node exponent validation ok");

assert.equal(types.isKeyObject(Object.create(KeyObject.prototype)), false);
assert.equal(types.isCryptoKey(Object.create(CryptoKey.prototype)), false);
assert(types.isCryptoKey(webSecret));
console.log("node opaque key brands ok");

const rsaEquality = generateKeyPairSync("rsa", {
  modulusLength: 1024,
}).privateKey;
const equalityJwk = rsaEquality.export({ format: "jwk" });
const readInteger = (value) =>
  BigInt("0x" + Buffer.from(value, "base64url").toString("hex"));
const p = readInteger(equalityJwk.p),
  q = readInteger(equalityJwk.q),
  qi = readInteger(equalityJwk.qi);
let coefficient = (q - (((q * qi - 1n) / p) % q)).toString(16);
if (coefficient.length % 2) coefficient = "0" + coefficient;
const reordered = createPrivateKey({
  key: {
    ...equalityJwk,
    p: equalityJwk.q,
    q: equalityJwk.p,
    dp: equalityJwk.dq,
    dq: equalityJwk.dp,
    qi: Buffer.from(coefficient, "hex").toString("base64url"),
  },
  format: "jwk",
});
assert(rsaEquality.equals(reordered));
console.log("node key equality ok");
const x = generateKeyPairSync("x25519");
const peer = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
const xPrivate = createPrivateKey({
  key: x.privateKey.export({ format: "der", type: "pkcs8" }),
  format: "der",
  type: "pkcs8",
}).toCryptoKey("X25519", false, ["deriveBits"]);
const xPublic = createPublicKey({
  key: x.publicKey.export({ format: "der", type: "spki" }),
  format: "der",
  type: "spki",
}).toCryptoKey("X25519", true, []);
assert.deepEqual(
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: peer.publicKey },
      xPrivate,
      256,
    ),
  ),
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: xPublic },
      peer.privateKey,
      256,
    ),
  ),
);
console.log("node X25519 interop ok");

assert.equal(generateKeySync("hmac", { length: 129 }).symmetricKeySize, 16);
for (const length of [128, 192, 256])
  assert.equal(generateKeySync("aes", { length }).symmetricKeySize, length / 8);
await new Promise((resolve, reject) =>
  generateKey("aes", { length: 128 }, (err, key) => {
    if (err) return reject(err);
    assert.equal(key.symmetricKeySize, 16);
    resolve();
  }),
);
console.log("node secret generation ok");
