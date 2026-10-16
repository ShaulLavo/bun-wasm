import assert from "node:assert/strict";
const s = crypto.subtle;
const bytes = new TextEncoder().encode("bun-wasm crypto");
const equal = (a, b) => assert.deepEqual(new Uint8Array(a), new Uint8Array(b));
for (const algorithm of [
  { name: "HMAC", hash: "SHA-256" },
  { name: "ECDSA", namedCurve: "P-256" },
  { name: "ECDSA", namedCurve: "P-384" },
  { name: "Ed25519" },
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  {
    name: "RSA-PSS",
    modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
]) {
  const pair = await s.generateKey(algorithm, true, ["sign", "verify"]);
  const priv = pair.privateKey || pair,
    pub = pair.publicKey || pair;
  const op = { ...algorithm, hash: "SHA-256", saltLength: 32 };
  const sig = await s.sign(op, priv, bytes);
  assert(await s.verify(op, pub, sig, bytes));
  assert.equal(await s.verify(op, pub, sig, new Uint8Array([1])), false);
  const jwk = await s.exportKey("jwk", priv);
  const imported = await s.importKey("jwk", jwk, algorithm, true, ["sign"]);
  assert(await s.verify(op, pub, await s.sign(op, imported, bytes), bytes));
  if (pair.privateKey) {
    const pkcs8 = await s.exportKey("pkcs8", priv),
      spki = await s.exportKey("spki", pub);
    const importedPriv = await s.importKey("pkcs8", pkcs8, algorithm, true, [
      "sign",
    ]);
    const importedPub = await s.importKey("spki", spki, algorithm, true, [
      "verify",
    ]);
    assert(
      await s.verify(
        op,
        importedPub,
        await s.sign(op, importedPriv, bytes),
        bytes,
      ),
    );
  }
  console.log("sign", algorithm.name, algorithm.namedCurve || "ok");
}
for (const name of ["AES-GCM", "AES-CBC", "AES-CTR"]) {
  const key = await s.generateKey({ name, length: 256 }, true, [
    "encrypt",
    "decrypt",
    "wrapKey",
    "unwrapKey",
  ]);
  const op = {
    name,
    iv: new Uint8Array(name === "AES-GCM" ? 12 : 16),
    counter: new Uint8Array(16),
    length: 64,
  };
  const cipher = await s.encrypt(op, key, bytes);
  equal(await s.decrypt(op, key, cipher), bytes);
  const wrapped = await s.wrapKey("raw", key, key, op);
  const unwrapped = await s.unwrapKey("raw", wrapped, key, op, { name }, true, [
    "encrypt",
  ]);
  equal(await s.exportKey("raw", unwrapped), await s.exportKey("raw", key));
  if (name === "AES-GCM") {
    const bad = new Uint8Array(cipher);
    bad[0] ^= 1;
    await assert.rejects(s.decrypt(op, key, bad), { name: "OperationError" });
  }
  console.log("cipher", name);
}
const rsaAlg = {
  name: "RSA-OAEP",
  modulusLength: 1024,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
const rsa = await s.generateKey(rsaAlg, true, ["encrypt", "decrypt"]);
equal(
  await s.decrypt(
    rsaAlg,
    rsa.privateKey,
    await s.encrypt(rsaAlg, rsa.publicKey, bytes),
  ),
  bytes,
);
console.log("cipher RSA-OAEP");
for (const name of ["PBKDF2", "HKDF"]) {
  const key = await s.importKey("raw", bytes, name, false, [
    "deriveBits",
    "deriveKey",
  ]);
  const op = {
    name,
    hash: "SHA-256",
    salt: new Uint8Array([1, 2, 3]),
    info: bytes,
    iterations: 10,
  };
  const bits = await s.deriveBits(op, key, 256);
  const aes = await s.deriveKey(
    op,
    key,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  equal(bits, await s.exportKey("raw", aes));
  console.log("derive", name);
}
for (const algorithm of [
  { name: "ECDH", namedCurve: "P-256" },
  { name: "ECDH", namedCurve: "P-384" },
  { name: "X25519" },
]) {
  const a = await s.generateKey(algorithm, true, ["deriveBits"]);
  const b = await s.generateKey(algorithm, true, ["deriveBits"]);
  equal(
    await s.deriveBits(
      { ...algorithm, public: b.publicKey },
      a.privateKey,
      128,
    ),
    await s.deriveBits(
      { ...algorithm, public: a.publicKey },
      b.privateKey,
      128,
    ),
  );
  const pub = await s.importKey(
    "spki",
    await s.exportKey("spki", b.publicKey),
    algorithm,
    true,
    [],
  );
  const priv = await s.importKey(
    "pkcs8",
    await s.exportKey("pkcs8", a.privateKey),
    algorithm,
    true,
    ["deriveBits"],
  );
  equal(
    await s.deriveBits({ ...algorithm, public: pub }, priv, 128),
    await s.deriveBits(
      { ...algorithm, public: b.publicKey },
      a.privateKey,
      128,
    ),
  );
  const full = await s.deriveBits(
    { ...algorithm, public: b.publicKey },
    a.privateKey,
  );
  assert.equal(full.byteLength, algorithm.namedCurve === "P-384" ? 48 : 32);
  equal(
    full,
    await s.deriveBits(
      { ...algorithm, public: a.publicKey },
      b.privateKey,
      null,
    ),
  );
  console.log("agree", algorithm.name, algorithm.namedCurve || "ok");
}
const hidden = await s.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
  "sign",
]);
await assert.rejects(s.exportKey("raw", hidden), {
  name: "InvalidAccessError",
});
await assert.rejects(s.verify("HMAC", hidden, new Uint8Array(32), bytes), {
  name: "InvalidAccessError",
});
await assert.rejects(
  s.generateKey({ name: "AES-GCM", length: 111 }, true, ["encrypt"]),
  { name: "OperationError" },
);
console.log("validation ok");
const wrapping = await s.generateKey({ name: "AES-KW", length: 256 }, true, [
  "wrapKey",
  "unwrapKey",
]);
const wrappable = await s.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [
  "sign",
]);
const wrapped = await s.wrapKey("jwk", wrappable, wrapping, "AES-KW");
const unwrapped = await s.unwrapKey(
  "jwk",
  wrapped,
  wrapping,
  "AES-KW",
  { name: "HMAC", hash: "SHA-256" },
  true,
  ["sign"],
);
assert.equal(unwrapped.type, "secret");
console.log("wrap AES-KW");
const notValid = async (call, name) => assert.rejects(call, { name });
const hmac = await s.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [
  "sign",
  "verify",
]);
const hmacJwk = await s.exportKey("jwk", hmac);
await notValid(
  s.importKey(
    "jwk",
    { ...hmacJwk, key_ops: ["sign", "sign"] },
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  ),
  "DataError",
);
await notValid(
  s.importKey(
    "jwk",
    { ...hmacJwk, k: "??" },
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  ),
  "DataError",
);
await notValid(
  s.generateKey({ name: "AES-GCM", length: 256 }, true, ["sign"]),
  "SyntaxError",
);
const a = await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
  "deriveBits",
]);
const b = await s.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, [
  "deriveBits",
]);
await notValid(
  s.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 128),
  "InvalidAccessError",
);
assert(crypto instanceof Crypto);
assert(hmac instanceof CryptoKey);
assert(s instanceof SubtleCrypto);
const descriptor = hmac.algorithm;
descriptor.hash.name = "SHA-1";
assert.equal(hmac.algorithm.hash.name, "SHA-1");
const checkHmac = await s.importKey(
  "jwk",
  hmacJwk,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["verify"],
);
assert(
  await s.verify("HMAC", checkHmac, await s.sign("HMAC", hmac, bytes), bytes),
);
console.log("key boundaries ok");

assert.doesNotThrow(() => {
  crypto.subtle = 123;
});
assert.equal(crypto.subtle, s);
console.log("subtle identity ok");
