import crypto from "node:crypto";

// createSign and crypto.sign accept OpenSSL's digest names and their signature-algorithm
// aliases (sha256WithRSAEncryption, RSA-SHA256, RSA-MD5, ...). PKCS#1 v1.5 signatures are
// deterministic, so the fixture prints them. Also covers the unsupported `context` option
// and randomInt's argument checks.
const pem = `-----BEGIN PRIVATE KEY-----
MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBALurc2uIclHQkM2K
Ircx9hQFlVDHpl6EPELjSXWzN2CZLCiQndbN42QEQbcngpVqyMuzF6LB6JEPh+nN
BZ79KILxEK5dieSiDsgkSZ/uUo69CgZbeEnh97ZwCAGb6h73rtxOzrch+LcXpSFy
hJPeNIUjVC9g3Wz3OLfTWzN5JeJfAgMBAAECgYBkHEGly1OwcSHNgzKhpvUuGQxd
2yLUqJW82KIHN2MDFLKJsRuByrLSV7L2kQ0Hx771asPg/q+hMje+cK/e8Az7Ypcr
54bBgK3RTF/dKLycv2mZkK2zA8XUXs+dB8gYgOoIK9fTi0fsy4fm5P/CQvJ1fafx
5RbvqH9VN89NlCpgAQJBAOaGZrSqILH02+29/C4MRNTnxti8tG3DwvH0VzUlQ5wg
XrGvZflMB7PC8DfWCTpYIdifBtuPFPhaDRbeFvJQLQECQQDQaKpR64hdazgPSZt8
masQRia20R1aAszpfFJ5tjWfugIy2yIJbOO8iol5qp89qSBGKDcSEhZjhQ3rrA3b
Ii9fAkA4zcN/HzDhSPnsklUSr7lCUT6hZ5Z6ObPO1SusD9uiHCPZWuQg0whO1mlF
CPvLIa5tZ3pUHeTH8cCp8t3qpbEBAkEAnfEkWu8YKkwucQ+EobpHtQ6lGlmCWAvV
RYGtc4YOP52VOvttYR0/vkxzgVw4UF+TEPg7PBuvEf7tHNUIrzDKGwJBAJAVLZWc
02YDo/ZhAA1RV5F4gDIZzhNzQ5O+w/ElXr6xzmFTjOxM6xU8WWvP1QSwGFkZSRMw
YeV1LG0WZzSR9sE=
-----END PRIVATE KEY-----
`;
const show = (label: string, make: () => unknown) => {
  try {
    console.log(label, String(make()));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};
const publicKey = crypto.createPublicKey(pem);

const names = [
  "sha1", "RSA-SHA1", "sha1WithRSAEncryption", "SHA256", "sha224WithRSAEncryption", "RSA-SHA224",
  "sha256WithRSAEncryption", "RSA-SHA256", "sha384WithRSAEncryption", "RSA-SHA384",
  "sha512WithRSAEncryption", "RSA-SHA512", "md5", "RSA-MD5", "md5WithRSAEncryption",
  "no-such-digest", "SHA256WITHRSAENCRYPTION", "Sha256", "rsa-sha256", "sha-256", "SHA-384", "RSA-SHA-256",
  "dss1", "sha128", "ecdsa-with-SHA1",
];
for (const name of names) {
  show(`createSign ${name}`, () => {
    const signature = crypto.createSign(name).update("text").sign(pem, "base64");
    const verified = crypto.createVerify(name).update("text").verify(publicKey, signature, "base64");
    return `${signature.slice(0, 24)} ${verified}`;
  });
}
show("sign RSA-SHA256 one-shot", () => crypto.sign("RSA-SHA256", Buffer.from("text"), pem).toString("base64").slice(0, 24));
show("verify md5WithRSAEncryption one-shot", () =>
  crypto.verify("md5WithRSAEncryption", Buffer.from("text"), publicKey, crypto.sign("md5", Buffer.from("text"), pem)),
);
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
show("ecdsa sha256WithRSAEncryption", () =>
  crypto.verify("sha256", Buffer.from("ec"), ec.publicKey, crypto.sign("sha256WithRSAEncryption", Buffer.from("ec"), ec.privateKey)),
);

// MD5 signs only with RSA keys.
for (const name of ["md5", "RSA-MD5", "md5WithRSAEncryption"]) show(`ecdsa ${name}`, () => crypto.sign(name, Buffer.from("ec"), ec.privateKey).length);
show("ecdsa createSign md5", () => crypto.createSign("md5").update("ec").sign(ec.privateKey).length);
show("ecdsa verify md5", () => crypto.verify("md5", Buffer.from("ec"), ec.publicKey, Buffer.alloc(64)));

// Only Ed448 takes a signing context, and BoringSSL has no Ed448.
show("sign context", () => crypto.sign("sha256", Buffer.from("x"), { key: pem, context: Buffer.alloc(1) } as never));
show("verify context", () => crypto.verify("sha256", Buffer.from("x"), { key: publicKey, context: Buffer.alloc(1) } as never, Buffer.alloc(128)));
await new Promise<void>(resolve =>
  crypto.sign("sha256", Buffer.from("x"), { key: pem, context: Buffer.alloc(1) } as never, (error: (Error & { code?: string }) | null) => {
    console.log("sign context callback", error?.code, error?.message);
    resolve();
  }),
);

// hkdf checks its digest before it schedules the callback.
show("hkdf bad digest", () => crypto.hkdf("nope", "key", "", "", 1, () => console.log("hkdf callback ran")));
show("hkdf digest type", () => crypto.hkdf(5 as never, "key", "", "", 1, () => console.log("hkdf callback ran")));
show("hkdfSync digest type", () => crypto.hkdfSync(5 as never, "key", "", "", 1));
show("hkdfSync RSA-SHA256", () => Buffer.from(crypto.hkdfSync("RSA-SHA256", "key", "salt", "info", 4)).toString("hex"));
show("randomInt()",() => crypto.randomInt(undefined as never));
show("randomInt(1.5)", () => crypto.randomInt(1.5));
show("randomInt(0)", () => crypto.randomInt(0));
show("randomInt(5, 5)", () => crypto.randomInt(5, 5));
show("randomInt(0, 2 ** 48)", () => crypto.randomInt(0, 2 ** 48));
show("randomInt(2 ** 34, 2 ** 33)", () => crypto.randomInt(2 ** 34, 2 ** 33));
show("randomInt(-(2 ** 48), 2 ** 48)", () => crypto.randomInt(-(2 ** 48), 2 ** 48));
show("randomInt(1, 2, 3)", () => crypto.randomInt(1, 2, 3 as never));
show("randomInt(1, 2)", () => crypto.randomInt(1, 2));
show("randomInt(-3, -2)", () => crypto.randomInt(-3, -2));
show("randomInt range", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) seen.add(crypto.randomInt(3));
  return Array.from(seen).sort().join(",");
});
crypto.randomInt(7, 8, (error, value) => console.log("randomInt callback", error, value));

// One-shot verify takes the signature only as a view, checked before the key.
show("verify string signature", () => crypto.verify(null, Buffer.alloc(1), "test", "oops" as never));
show("verify number signature", () => crypto.verify("sha256", Buffer.alloc(1), "test", 5 as never));
for (const length of [128, 192, 256, 128.5, 64, "128", undefined]) {
  show(`generateKeySync aes ${String(length)}`, () => crypto.generateKeySync("aes", { length } as never).symmetricKeySize);
}
show("generateKeySync hmac 7", () => crypto.generateKeySync("hmac", { length: 7 }).symmetricKeySize);
show("generateKeySync hmac string", () => crypto.generateKeySync("hmac", { length: "8" as never }).symmetricKeySize);
show("generateKeySync hmac 20", () => crypto.generateKeySync("hmac", { length: 20 }).symmetricKeySize);
// crypto.Hash and crypto.Hmac are util.deprecate wrappers (DEP0179, DEP0181).
process.noDeprecation = true;
show("constructor names", () => [crypto.Hash.name, crypto.Hmac.name, crypto.Sign.name, crypto.Verify.name].join());
show("new Hash", () => new (crypto.Hash as unknown as new (algorithm: string) => crypto.Hash)("sha256").update("a").digest("hex").slice(0, 8));
show("Hash()", () => (crypto.Hash as unknown as (algorithm: string) => crypto.Hash)("sha256") instanceof crypto.Hash);
