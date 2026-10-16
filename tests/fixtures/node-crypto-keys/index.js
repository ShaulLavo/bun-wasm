import assert from "node:assert/strict";
import { types } from "node:util";
import {
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
