import crypto from "node:crypto";

// node:crypto Diffie-Hellman, ECDH and crypto.diffieHellman: RFC 3526 groups, RFC 5903 and
// RFC 7748 vectors, and Node's argument checks with native Bun's messages.
// ecdh.setPublicKey() warns with DEP0031 once; keep stderr empty as the fixture runner expects.
process.noDeprecation = true;
const hex = (value: string) => Buffer.from(value.replace(/\s+/g, ""), "hex");
const describe = (value: unknown) =>
  value instanceof Uint8Array ? `${value.constructor.name} ${Buffer.from(value).toString("hex")}` : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
const show = (label: string, make: () => unknown) => {
  try {
    console.log(label, describe(make()));
  } catch (error) {
    const failure = error as Error & { code?: string };
    // The inspected KeyObject in a message is runtime-specific; keep the message before it.
    console.log(label, "throws", failure.name, failure.code, failure.message.replace(/ Received KeyObject .*/s, " Received KeyObject"));
  }
};

// Classic Diffie-Hellman over the RFC 3526 groups.
for (const name of ["MODP5", "modp14", "modp15", "modp16", "modp17", "modp18", "modp1", "modp2", "modp99"]) {
  show(`group ${name}`, () => {
    const group = crypto.getDiffieHellman(name);
    const prime = group.getPrime();
    return `${prime.length} ${prime.subarray(0, 4).toString("hex")} ${prime.subarray(-4).toString("hex")} ${group.getGenerator("hex")} ${group.verifyError}`;
  });
}
show("group not string", () => crypto.getDiffieHellman(5 as never));
{
  const prime = crypto.getDiffieHellman("modp5").getPrime();
  const alice = crypto.createDiffieHellman(prime, 2);
  const bob = crypto.createDiffieHellman(prime.toString("hex"), "hex", Buffer.from([2]));
  alice.setPrivateKey(Buffer.alloc(32, 0x11));
  bob.setPrivateKey("22".repeat(32), "hex");
  console.log("dh fixed public", alice.generateKeys("hex").slice(0, 32), bob.generateKeys().length);
  const secret = alice.computeSecret(bob.getPublicKey());
  console.log("dh fixed secret", secret.length, secret.subarray(0, 16).toString("hex"), secret.equals(bob.computeSecret(alice.getPublicKey("base64"), "base64")));
  console.log("dh hex secret", alice.computeSecret(bob.getPublicKey("hex"), "hex", "hex") === secret.toString("hex"));
  console.log("dh private", alice.getPrivateKey("hex") === "11".repeat(32), alice.verifyError, bob.verifyError);
  const fresh = crypto.createDiffieHellman(prime, 2);
  show("dh no public key", () => fresh.getPublicKey());
  show("dh no private key", () => fresh.getPrivateKey());
  show("dh compute without keys", () => fresh.computeSecret(alice.getPublicKey()));
  show("dh invalid peer 1", () => alice.computeSecret(Buffer.from([1])));
  show("dh invalid peer p", () => alice.computeSecret(prime));
  show("dh empty peer", () => alice.computeSecret(Buffer.alloc(0)));
  show("dh peer wrong type", () => alice.computeSecret(5 as never));
  const random = crypto.createDiffieHellman(prime, 2);
  const publicKey = random.generateKeys();
  console.log("dh random", publicKey.length <= 192, random.getPrivateKey().length > 0, random.computeSecret(alice.getPublicKey()).equals(alice.computeSecret(publicKey)));
  console.log("dh setPublicKey chain", fresh.setPublicKey(publicKey) === fresh, fresh.getPublicKey().equals(publicKey));
}
for (const [label, make] of [
  ["dh generated 512", () => crypto.createDiffieHellman(512)],
  ["dh generated 512 gen 5", () => crypto.createDiffieHellman(512, 5)],
] as const) {
  show(label, () => {
    const dh = make();
    const keys = dh.generateKeys();
    return `${dh.getPrime().length} ${dh.getGenerator("hex")} ${dh.verifyError} ${keys.length > 0} ${crypto.checkPrimeSync(dh.getPrime())}`;
  });
}
show("dh size too small", () => crypto.createDiffieHellman(1));
show("dh size not int32", () => crypto.createDiffieHellman(2 ** 40));
show("dh size fraction", () => crypto.createDiffieHellman(512.5));
show("dh generator string with size", () => crypto.createDiffieHellman(1024, "abc"));
show("dh generator 1", () => crypto.createDiffieHellman(1024, 1));
show("dh bad sizeOrKey", () => crypto.createDiffieHellman({} as never));
show("dh bad generator", () => crypto.createDiffieHellman(Buffer.from([23]), {} as never));
show("dh buffer generator 0", () => crypto.createDiffieHellman(Buffer.from([23]), Buffer.from([0])));
show("dh buffer generator 1", () => crypto.createDiffieHellman(Buffer.from([23]), Buffer.from([1])));
show("dh number generator 0", () => crypto.createDiffieHellman(Buffer.from([23]), 0));
show("dh tiny prime", () => {
  const dh = crypto.createDiffieHellman(Buffer.from([23]), 5);
  return `${dh.verifyError} ${dh.getGenerator("hex")}`;
});
show("dh composite prime", () => crypto.createDiffieHellman(Buffer.from([0x01, 0x01]), 2).verifyError);
show("dh empty prime", () => crypto.createDiffieHellman(Buffer.alloc(0), 2));
// A small safe prime keeps the construction-time check fast.
const small = Buffer.from([0x17]);
show("dh double generator", () => crypto.createDiffieHellman(small, new Float64Array([5])[0]).getGenerator("hex"));
show("dh wide generator", () => crypto.createDiffieHellman(small, Buffer.from("0100000000", "hex")).getGenerator("hex"));
show("dh new without factory", () => new crypto.DiffieHellman(small).getGenerator("hex"));
show("dh call without new", () => (crypto.DiffieHellman as unknown as Function)(small) instanceof crypto.DiffieHellman);
// Last of the error cases: native Bun leaves this failure's errors queued for later reads.
show("dh size 2", () => crypto.createDiffieHellman(2));
show("dh group class", () => {
  const group = crypto.createDiffieHellmanGroup("modp5");
  return `${group instanceof crypto.DiffieHellmanGroup} ${"setPrivateKey" in group} ${"verifyError" in crypto.DiffieHellmanGroup.prototype} ${Object.keys(group).join("|")}`;
});
show("dh verifyError own", () => `${"verifyError" in crypto.DiffieHellman.prototype} ${Object.getOwnPropertyNames(crypto.createDiffieHellman(Buffer.from([23]), 5)).join("|")}`);
{
  class Mine extends crypto.DiffieHellman {
    hexKey() {
      return this.getPublicKey("hex");
    }
  }
  const group = crypto.getDiffieHellman("modp5");
  const mine = new Mine(group.getPrime(), group.getGenerator());
  mine.generateKeys();
  group.generateKeys();
  console.log("dh subclass", Object.getPrototypeOf(mine) === Mine.prototype, mine.hexKey() === mine.getPublicKey("hex"), mine.computeSecret(group.getPublicKey()).equals(group.computeSecret(mine.getPublicKey())));
}
console.log("dh names", ["generateKeys", "computeSecret", "getPrime", "getGenerator", "getPublicKey", "getPrivateKey", "setPublicKey", "setPrivateKey"].map(name => (crypto.createDiffieHellman(Buffer.from([23]), 5) as unknown as Record<string, Function>)[name].name).join(","), crypto.createDiffieHellman.name);

// ECDH with RFC 5903 section 8 vectors.
const rfc5903 = {
  prime256v1: {
    i: "c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433",
    gi: "04dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb3",
    r: "c6ef9c5d78ae012a011164acb397ce2088685d8f06bf9be0b283ab46476bee53",
    gr: "04d12dfb5289c8d4f81208b70270398c342296970a0bccb74c736fc7554494bf6356fbf3ca366cc23e8157854c13c58d6aac23f046ada30f8353e74f33039872ab",
    secret: "d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de",
  },
  secp384r1: {
    i: "099f3c7034d4a2c699884d73a375a67f7624ef7c6b3c0f160647b67414dce655e35b538041e649ee3faef896783ab194",
    gi: "04667842d7d180ac2cde6f74f37551f55755c7645c20ef73e31634fe72b4c55ee6de3ac808acb4bdb4c88732aee95f41aa9482ed1fc0eeb9cafc4984625ccfc23f65032149e0e144ada024181535a0f38eeb9fcff3c2c947dae69b4c634573a81c",
    r: "41cb0779b4bdb85d47846725fbec3c9430fab46cc8dc5060855cc9bda0aa2942e0308312916b8ed2960e4bd55a7448fc",
    gr: "04e558dbef53eecde3d3fccfc1aea08a89a987475d12fd950d83cfa41732bc509d0d1ac43a0336def96fda41d0774a3571dcfbec7aacf3196472169e838430367f66eebe3c6e70c416dd5f0c68759dd1fff83fa40142209dff5eaad96db9e6386c",
    secret: "11187331c279962d93d604243fd592cb9d0a926f422e47187521287e7156c5c4d603135569b9e9d09cf5d4a270f59746",
  },
};
for (const [curve, v] of Object.entries(rfc5903)) {
  const alice = crypto.createECDH(curve);
  alice.setPrivateKey(v.i, "hex");
  const bob = crypto.createECDH(curve);
  bob.setPrivateKey(hex(v.r));
  console.log(`ecdh ${curve}`, alice.getPublicKey("hex") === v.gi, bob.getPublicKey().toString("hex") === v.gr, alice.computeSecret(bob.getPublicKey()).toString("hex") === v.secret, bob.computeSecret(v.gi, "hex", "hex") === v.secret);
  console.log(`ecdh ${curve} compressed`, alice.getPublicKey("hex", "compressed"), alice.getPrivateKey("hex") === v.i);
  show(`ecdh ${curve} hybrid`, () => alice.getPublicKey("hex", "hybrid"));
  show(`ecdh ${curve} bad format`, () => alice.getPublicKey("hex", "nope" as never));
  console.log(`ecdh ${curve} compressed peer`, alice.computeSecret(bob.getPublicKey(null, "compressed")).toString("hex") === v.secret);
  console.log(`ecdh ${curve} convertKey`, crypto.ECDH.convertKey(v.gi, curve, "hex", "hex", "compressed") === alice.getPublicKey("hex", "compressed"), (crypto.ECDH.convertKey(alice.getPublicKey(null, "compressed"), curve) as Buffer).toString("hex") === v.gi);
}
{
  const ecdh = crypto.createECDH("secp521r1");
  const other = crypto.createECDH("secp521r1");
  const key = ecdh.generateKeys();
  other.generateKeys();
  console.log("ecdh p521", key.length, ecdh.getPublicKey(null, "compressed").length, ecdh.computeSecret(other.getPublicKey()).equals(other.computeSecret(key)), ecdh.computeSecret(other.getPublicKey()).length);
  const p224 = crypto.createECDH("secp224r1");
  console.log("ecdh p224", p224.generateKeys().length, p224.getPrivateKey().length <= 28);
  ecdh.setPrivateKey(Buffer.from([0, 0, 1]));
  console.log("ecdh small private", ecdh.getPrivateKey("hex"), ecdh.getPublicKey().length);
}
show("ecdh unknown curve", () => crypto.createECDH("P-256"));
show("ecdh secp256k1", () => crypto.createECDH("secp256k1"));
show("ecdh curve not string", () => crypto.createECDH(5 as never));
{
  const ecdh = crypto.createECDH("prime256v1");
  show("ecdh no public key", () => ecdh.getPublicKey());
  show("ecdh no private key", () => ecdh.getPrivateKey());
  show("ecdh compute without keys", () => ecdh.computeSecret(hex(rfc5903.prime256v1.gr)));
  show("ecdh compute no args", () => (ecdh.computeSecret as unknown as () => Buffer)());
  ecdh.generateKeys();
  show("ecdh invalid peer", () => ecdh.computeSecret(Buffer.from([4, 1, 2, 3])));
  show("ecdh peer from other curve", () => ecdh.computeSecret(hex(rfc5903.secp384r1.gr)));
  show("ecdh private zero", () => ecdh.setPrivateKey(Buffer.alloc(32)));
  show("ecdh private too big", () => ecdh.setPrivateKey(Buffer.alloc(32, 0xff)));
  show("ecdh private wrong type", () => ecdh.setPrivateKey(5 as never));
  show("ecdh setPublicKey", () => {
    const fresh = crypto.createECDH("prime256v1");
    fresh.setPublicKey(rfc5903.prime256v1.gi, "hex");
    return fresh.getPublicKey("hex") === rfc5903.prime256v1.gi;
  });
  show("ecdh setPublicKey invalid", () => crypto.createECDH("prime256v1").setPublicKey(Buffer.from([4, 1])));
  show("ecdh public-only compute", () => {
    const fresh = crypto.createECDH("prime256v1");
    fresh.setPublicKey(hex(rfc5903.prime256v1.gi));
    return fresh.computeSecret(hex(rfc5903.prime256v1.gr));
  });
  show("convertKey bad curve", () => crypto.ECDH.convertKey(hex(rfc5903.prime256v1.gi), "nope"));
  show("convertKey bad point", () => crypto.ECDH.convertKey(Buffer.from([4, 1]), "prime256v1"));
  show("convertKey curve not string", () => crypto.ECDH.convertKey(hex(rfc5903.prime256v1.gi), 5 as never));
  console.log("ecdh names", ["generateKeys", "computeSecret", "getPublicKey", "getPrivateKey", "setPublicKey", "setPrivateKey"].map(name => (ecdh as unknown as Record<string, Function>)[name].name).join(","), crypto.createECDH.name, crypto.createECDH("prime256v1") instanceof crypto.ECDH);
}
console.log("getCurves", JSON.stringify(crypto.getCurves()));

// crypto.diffieHellman with KeyObjects.
{
  const alice = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: hex(rfc5903.prime256v1.i).toString("base64url"), x: hex(rfc5903.prime256v1.gi).subarray(1, 33).toString("base64url"), y: hex(rfc5903.prime256v1.gi).subarray(33).toString("base64url") }, format: "jwk" });
  const bob = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: hex(rfc5903.prime256v1.gr).subarray(1, 33).toString("base64url"), y: hex(rfc5903.prime256v1.gr).subarray(33).toString("base64url") }, format: "jwk" });
  console.log("diffieHellman ec", crypto.diffieHellman({ privateKey: alice, publicKey: bob }).toString("hex") === rfc5903.prime256v1.secret);
  const x25519Alice = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a").toString("base64url"), x: hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a").toString("base64url") }, format: "jwk" });
  const x25519Bob = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f").toString("base64url") }, format: "jwk" });
  console.log("diffieHellman x25519", crypto.diffieHellman({ privateKey: x25519Alice, publicKey: x25519Bob }).toString("hex"));
  console.log("diffieHellman private as public", crypto.diffieHellman({ privateKey: alice, publicKey: alice }).length);
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
  show("diffieHellman curve mismatch", () => crypto.diffieHellman({ privateKey: alice, publicKey: p384.publicKey }));
  show("diffieHellman type mismatch", () => crypto.diffieHellman({ privateKey: alice, publicKey: x25519Bob }));
  show("diffieHellman public as private", () => crypto.diffieHellman({ privateKey: bob, publicKey: bob }));
  show("diffieHellman secret key", () => crypto.diffieHellman({ privateKey: crypto.createSecretKey(Buffer.alloc(16)), publicKey: bob }));
  show("diffieHellman not a key", () => crypto.diffieHellman({ privateKey: "nope" as never, publicKey: bob }));
  show("diffieHellman not an object", () => crypto.diffieHellman(5 as never));
  show("diffieHellman ed25519", () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    return crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: pair.publicKey });
  });
  show("diffieHellman bad callback", () => crypto.diffieHellman({ privateKey: alice, publicKey: bob }, 5 as never));
  const result = await new Promise(resolve => crypto.diffieHellman({ privateKey: alice, publicKey: bob }, (error, secret) => resolve(`${error} ${secret.toString("hex") === rfc5903.prime256v1.secret}`)));
  console.log("diffieHellman callback", result);
  const failure = await new Promise<Error & { code?: string }>(resolve => crypto.diffieHellman({ privateKey: alice, publicKey: p384.publicKey }, error => resolve(error!)));
  console.log("diffieHellman callback failure", failure.code, failure.message);
}
