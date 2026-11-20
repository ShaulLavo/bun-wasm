// WebCrypto ChaCha20-Poly1305: the RFC 8439 section 2.8.2 vector, key formats, Bun's
// parameter and usage errors, deriveKey, key wrapping and structuredClone. The browser
// engine delegates WebCrypto to its host, so this fixture skips it.
const subtle = crypto.subtle;
const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");
const report = async (label: string, run: () => Promise<unknown>) => {
  try {
    const value = await run();
    console.log(label, value instanceof ArrayBuffer ? hex(value).slice(0, 48) : typeof value === "object" ? JSON.stringify(value) : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code ?? "", failure.message);
  }
};
const algorithm = "ChaCha20-Poly1305";
const material = new Uint8Array(32).map((_, i) => 0x80 + i);
const iv = new Uint8Array([0x07, 0, 0, 0, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
const additionalData = new Uint8Array([0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7]);
const text = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");

const key = await subtle.importKey("raw-secret", material, algorithm, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
console.log("key", JSON.stringify(key.algorithm), key.type, key.extractable, JSON.stringify(key.usages));
const sealed = await subtle.encrypt({ name: algorithm, iv, additionalData }, key, text);
console.log("sealed", sealed.byteLength, hex(sealed).slice(0, 32), hex(sealed).slice(-32));
console.log("opened", new TextDecoder().decode(await subtle.decrypt({ name: algorithm, iv, additionalData, tagLength: 128 }, key, sealed)).slice(0, 20));
const tampered = new Uint8Array(sealed.slice(0));
tampered[0] ^= 1;
await report("tampered", () => subtle.decrypt({ name: algorithm, iv, additionalData }, key, tampered));
await report("short", () => subtle.decrypt({ name: algorithm, iv }, key, new Uint8Array(5)));
for (const size of [0, 11, 16]) await report(`iv ${size}`, () => subtle.encrypt({ name: algorithm, iv: new Uint8Array(size) }, key, text));
await report("no iv", () => subtle.encrypt({ name: algorithm } as never, key, text));
await report("tag 64", () => subtle.encrypt({ name: algorithm, iv, tagLength: 64 } as never, key, text));

await report("export raw-secret", () => subtle.exportKey("raw-secret", key));
await report("export raw", () => subtle.exportKey("raw", key));
const jwk = await subtle.exportKey("jwk", key);
console.log("jwk", jwk.kty, jwk.alg, jwk.k, JSON.stringify(jwk.key_ops), jwk.ext);
await report("import jwk", async () => (await subtle.importKey("jwk", jwk, algorithm, false, ["decrypt"])).algorithm);
await report("import raw", () => subtle.importKey("raw", material, algorithm, true, ["encrypt"]));
await report("import 16 bytes", () => subtle.importKey("raw-secret", new Uint8Array(16), algorithm, true, ["encrypt"]));
await report("import jwk wrong alg", () => subtle.importKey("jwk", { ...jwk, alg: "A256GCM" }, algorithm, true, ["encrypt"]));
await report("import jwk duplicate ops", () => subtle.importKey("jwk", { ...jwk, key_ops: ["encrypt", "encrypt"] }, algorithm, true, ["encrypt"]));
await report("import sign usage", () => subtle.importKey("raw-secret", material, algorithm, true, ["sign"]));
await report("generate", async () => {
  const generated = (await subtle.generateKey({ name: algorithm, length: 128 } as never, true, ["encrypt"])) as CryptoKey;
  return [generated.algorithm, (await subtle.exportKey("raw-secret", generated)).byteLength];
});
await report("generate sign usage", () => subtle.generateKey(algorithm, true, ["sign"]));
await report("generate no usages", () => subtle.generateKey(algorithm, true, []));

const base = await subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]);
const derived = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(8), info: new Uint8Array(0) }, base, { name: algorithm }, true, ["encrypt", "decrypt"]);
await report("derived", async () => hex(await subtle.exportKey("raw-secret", derived)));

const aes = await subtle.importKey("raw", new Uint8Array(16).fill(3), "AES-GCM", true, ["encrypt"]);
const wrapped = await subtle.wrapKey("raw", aes, key, { name: algorithm, iv });
console.log("wrapped", hex(wrapped));
const unwrapped = await subtle.unwrapKey("raw", wrapped, key, { name: algorithm, iv }, "AES-GCM", true, ["encrypt"]);
console.log("unwrapped", hex(await subtle.exportKey("raw", unwrapped)));
const wrappedSelf = await subtle.wrapKey("jwk", key, key, { name: algorithm, iv });
await report("unwrap jwk", async () => (await subtle.unwrapKey("jwk", wrappedSelf, key, { name: algorithm, iv }, algorithm, false, ["encrypt"])).algorithm);

const clone = structuredClone(key);
console.log("clone", JSON.stringify(clone.algorithm), clone.type, clone.extractable, JSON.stringify(clone.usages), clone !== key);
const fromClone = await subtle.encrypt({ name: algorithm, iv }, clone, new Uint8Array([1, 2, 3]));
console.log("clone encrypts", hex(await subtle.decrypt({ name: algorithm, iv }, key, fromClone)));
const hidden = structuredClone(await subtle.importKey("raw-secret", material, algorithm, false, ["encrypt"]));
await report("clone not extractable", () => subtle.exportKey("raw-secret", hidden));
const hmacClone = structuredClone(await subtle.importKey("raw", new Uint8Array(8).fill(1), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
await report("hmac clone", async () => hex(await subtle.sign("HMAC", hmacClone, new Uint8Array([1]))));
