import crypto from "node:crypto";
import { promisify } from "node:util";

// crypto.pbkdf2 and pbkdf2Sync: derived keys for every digest Bun accepts, and Node's
// argument checks with native Bun's messages.
const show = (label: string, make: () => unknown) => {
  try {
    const value = make();
    console.log(label, value instanceof Uint8Array ? `${value.constructor.name} ${Buffer.from(value).toString("hex")}` : value);
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};

show("rfc6070 sha1 c=1", () => crypto.pbkdf2Sync("password", "salt", 1, 20, "sha1"));
show("rfc6070 sha1 c=4096", () => crypto.pbkdf2Sync("password", "salt", 4096, 20, "sha1"));
show("rfc6070 long", () => crypto.pbkdf2Sync("passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 25, "sha1"));
show("rfc6070 nul", () => crypto.pbkdf2Sync("pass\0word", "sa\0lt", 4096, 16, "sha1"));
show("rfc7914 sha256 64", () => crypto.pbkdf2Sync("passwd", "salt", 1, 64, "sha256"));
show("empty", () => crypto.pbkdf2Sync("", "", 1, 32, "sha256"));
show("sha512 70", () => crypto.pbkdf2Sync("p", "s", 3, 70, "sha512"));
for (const digest of ["SHA256", "sha-256", "sha128", "md5", "md4", "sha224", "sha384", "sha512-224", "SHA-512/224", "sha512-256", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "blake2b256", "blake2b512", "ripemd160", "rmd160", "blake2s256", "shake128", "shake256", "md5-sha1", "rsa-sha256", "RSA-SHA1", "dss1", "md55"]) {
  show(`digest ${digest}`, () => crypto.pbkdf2Sync("p", "s", 2, 8, digest));
}
show("dataview salt", () => crypto.pbkdf2Sync(new Uint8Array([1, 2]), new DataView(new ArrayBuffer(3)), 1, 8, "sha1"));
show("string object password", () => crypto.pbkdf2Sync(new String("password") as never, "salt", 1, 8, "sha256"));
show("salt detached while the password is coerced", () => {
  const salt = new Uint8Array(64).fill(3);
  const password = Object.assign(new String("password"), {
    toString() {
      structuredClone(salt.buffer, { transfer: [salt.buffer] });
      return "password";
    },
  });
  const key = crypto.pbkdf2Sync(password as never, salt, 1, 32, "sha256");
  return `${salt.byteLength} ${key.equals(crypto.pbkdf2Sync("password", new Uint8Array(0), 1, 32, "sha256"))}`;
});

for (const [label, args] of [
  ["iterations 0", ["p", "s", 0, 8, "sha256"]],
  ["iterations -1", ["p", "s", -1, 8, "sha256"]],
  ["iterations 1.5", ["p", "s", 1.5, 8, "sha256"]],
  ["iterations NaN", ["p", "s", Number.NaN, 8, "sha256"]],
  ["iterations 2**31", ["p", "s", 2 ** 31, 8, "sha256"]],
  ["iterations string", ["p", "s", "1", 8, "sha256"]],
  ["iterations null", ["p", "s", null, 8, "sha256"]],
  ["keylen -1", ["p", "s", 1, -1, "sha256"]],
  ["keylen 2**31", ["p", "s", 1, 2 ** 31, "sha256"]],
  ["keylen 32.9", ["p", "s", 1, 32.9, "sha256"]],
  ["keylen Infinity", ["p", "s", 1, Number.POSITIVE_INFINITY, "sha256"]],
  ["keylen string", ["p", "s", 1, "8", "sha256"]],
  ["keylen 0", ["p", "s", 1, 0, "sha256"]],
  ["keylen -0", ["p", "s", 1, -0, "sha256"]],
  ["password number", [1, "s", 1, 8, "sha256"]],
  ["salt object", ["p", {}, 1, 8, "sha256"]],
  ["digest undefined", ["p", "s", 1, 8, undefined]],
  ["digest number", ["p", "s", 1, 8, 5]],
] as const) {
  show(`sync ${label}`, () => (crypto.pbkdf2Sync as (...args: unknown[]) => unknown)(...args));
}

show("arity", () => `${crypto.pbkdf2.name} ${crypto.pbkdf2.length} ${crypto.pbkdf2Sync.name} ${crypto.pbkdf2Sync.length}`);
show("async digest omitted", () => (crypto.pbkdf2 as (...args: unknown[]) => unknown)("pw", "salt", 1, 8, () => {}));
show("async no callback", () => (crypto.pbkdf2 as (...args: unknown[]) => unknown)("pw", "salt", 1, 8, "sha256"));
show("async callback string", () => (crypto.pbkdf2 as (...args: unknown[]) => unknown)("pw", "salt", 1, 8, "sha256", "not a function"));
show("async bad digest before callback", () => (crypto.pbkdf2 as (...args: unknown[]) => unknown)("pw", "salt", 1, 8, "md55"));
show("async keylen out of range", () => crypto.pbkdf2("pw", "salt", 1, -1, "sha256", () => console.log("callback ran")));

const results = await new Promise<string>(resolve => {
  const returned = crypto.pbkdf2("pw", "salt", 1, 8, "sha256", (...args: unknown[]) => {
    resolve(`${args.length} ${args[0]} ${Buffer.isBuffer(args[1])} ${(args[1] as Buffer).toString("hex")} returned=${returned}`);
  });
});
console.log("async result", results);
console.log("async keylen 0", await new Promise<string>(resolve => crypto.pbkdf2("p", "s", 1, 0, "sha256", (error, key) => resolve(`${error?.name}: ${error?.message} ${key}`))));
console.log("promisify", (await promisify(crypto.pbkdf2)("pw", "salt", 1, 8, "sha256")).toString("hex"));
console.log("async sha3", await new Promise<string>(resolve => crypto.pbkdf2("p", "s", 2, 8, "sha3-256", (error, key) => resolve(`${error} ${key.toString("hex")}`))));
