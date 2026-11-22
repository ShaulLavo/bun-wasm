import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");
const runtime = join(root, "crates/bunwasm-runtime/src/js");
const converted = join(runtime, "crypto_keys.ts");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-crypto-keys-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("type erasure emits the runtime factory", () => {
  const output = join(scratch, "crypto_keys.js");
  const result = Bun.spawnSync(["node", "--no-warnings", join(root, "scripts/transpile-runtime.ts"), converted, output], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(output, "utf8").trimStart()).toStartWith("(function (internal");
});

const validProbe = `
declare const internal: Parameters<typeof cryptoKeysFactory>[0];
const factory = cryptoKeysFactory(internal);
declare const inputBytes: Parameters<typeof factory>[1];
declare const nodeBuffer: Parameters<typeof factory>[0];
const keys = factory(nodeBuffer, inputBytes, timingSafeEqual);
const data = nodeBuffer.from("node crypto keys");
const typed = new Uint8Array(data);
const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
keys.createSecretKey(data);
keys.createSecretKey(typed);
keys.createSecretKey(view);
keys.createSecretKey("secret", undefined);
const secret = keys.createSecretKey(data);
const secretBytes = secret.export({ format: "der" });
secretBytes.toString("base64");
const secretJwk = secret.export({ format: "jwk" });
const pair = keys.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537, hashAlgorithm: "sha256" });
const ed = keys.generateKeyPairSync("ed25519");
const edSignature = keys.sign(undefined, data, ed.privateKey);
keys.verify(undefined, data, ed.publicKey, edSignature);
const privatePem: string = pair.privateKey.export({ format: "pem", type: "pkcs8" });
const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
const encrypted: string = pair.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: typed });
keys.createPrivateKey({ key: encrypted, format: "pem", type: "pkcs8", passphrase: view });
keys.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8", passphrase: undefined });
keys.createPrivateKey({ key: pair.privateKey.export({ format: "jwk" }), format: "jwk" });
keys.createPublicKey({ key: publicDer, format: "der", type: "spki" });
const signature = keys.sign("sha256", typed, { key: pair.privateKey, padding: keys.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32, dsaEncoding: undefined }, undefined);
const verified: boolean = keys.verify("sha256", view, { key: pair.publicKey, padding: keys.constants.RSA_PKCS1_PSS_PADDING, saltLength: undefined }, signature, undefined);
keys.sign("sha256", data, pair.privateKey, (error, value) => {
  const failure: Error | null = error;
  const bytes = value.toString("base64");
  void failure;
  void bytes;
});
keys.verify("sha256", data, pair.publicKey, signature, (error, value) => {
  const failure: Error | null = error;
  const valid: boolean = value;
  void failure;
  void valid;
});
keys.generateKeyPair("ed25519", undefined, (error, publicKey, privateKey) => {
  const failure: Error | null = error;
  void failure;
  void publicKey;
  void privateKey;
});
keys.generateKeyPair("x25519", (error, publicKey, privateKey) => {
  void error;
  void publicKey;
  void privateKey;
});
keys.generateKey("hmac", { length: 128 }, (error, key) => {
  void error;
  void key;
});
const streamSigner = keys.createSign("sha256", undefined);
streamSigner.update(view);
streamSigner.write(data);
streamSigner.end();
streamSigner.on("finish", () => {});
const streamVerifier = keys.createVerify("sha256", undefined);
streamVerifier.update(typed);
streamVerifier.write(data);
streamVerifier.end();
streamVerifier.on("error", () => {});
const signer = streamSigner.sign(pair.privateKey, undefined);
const validStream: boolean = streamVerifier.verify(pair.publicKey, signer, undefined);
const derived: ArrayBuffer = keys.hkdfSync("sha256", secret, typed, view, 32);
keys.hkdf("sha256", typed, "salt", "info", 32, (error, value) => {
  void error;
  void value;
});
declare const webKey: CryptoKey;
keys.KeyObject.from(webKey).toCryptoKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
void verified;
void validStream;
void derived;
void secretJwk;
`;

function checkTypes(probe: string) {
  const path = join(scratch, "contract.ts");
  const source = readFileSync(converted, "utf8").replace("(function (internal:", "const cryptoKeysFactory = (function (internal:");
  writeFileSync(path, `${source}\nimport { timingSafeEqual } from "node:crypto";\n${probe}`);
  const config = join(scratch, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
    compilerOptions: { types: ["node"], typeRoots: [join(root, "node_modules/@types")], skipLibCheck: true },
    include: [],
    files: [join(runtime, "runtime.d.ts"), join(runtime, "crypto_host_types.d.ts"), path],
  }));
  return Bun.spawnSync([join(root, "node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("actual factory types accept Buffer, TypedArray, nullish options, formats and callbacks", () => {
  const result = checkTypes(validProbe);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

for (const probe of [
  "keys.createSecretKey(null);",
  'keys.generateKeySync("rsa", { length: 128 });',
  'keys.sign("sha256", data, null);',
  'pair.privateKey.export({ format: "der", type: "invalid" });',
  'keys.createSign("sha256").write();',
  'keys.createVerify("sha256").on("finish", "not a listener");',
]) {
  test(`actual factory types reject ${probe}`, () => {
    const result = checkTypes(`${validProbe}\n${probe}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
