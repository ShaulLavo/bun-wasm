import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const path = process.argv[2];
if (!path) throw new Error("Expected a factory source path");
const factory: unknown = runInNewContext(readFileSync(path, "utf8"), { ArrayBuffer, Uint8Array, Promise });
if (typeof factory !== "function") throw new Error("Expected a factory");
const native = webcrypto.subtle;
const provider = {
  generateKey: native.generateKey.bind(native), importKey: native.importKey.bind(native), exportKey: native.exportKey.bind(native),
  sign: native.sign.bind(native), verify: native.verify.bind(native), encrypt: native.encrypt.bind(native), decrypt: native.decrypt.bind(native),
  deriveBits: native.deriveBits.bind(native), deriveKey: native.deriveKey.bind(native), wrapKey: native.wrapKey.bind(native), unwrapKey: native.unwrapKey.bind(native),
};
const remembered = new Map<unknown, unknown>();
Reflect.apply(factory, undefined, [{ native: { subtleCrypto: provider }, crypto: {
  isWasmKey: () => false,
  buffer(value: unknown) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    throw new TypeError("Expected bytes");
  },
  encode: (value: Uint8Array) => Buffer.from(value).toString("base64url"),
  rememberKey: (key: unknown, data: unknown) => remembered.set(key, data),
} }]);
const key = await provider.importKey("raw", new Uint8Array(32).fill(3), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const data = Uint8Array.of(1, 2, 3);
const signature = await provider.sign("HMAC", key, data);
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (error) { if (error instanceof Error) return error.name; throw error; }
  throw new Error("Expected rejection");
}
console.log(JSON.stringify({ host: "Node", nativeKey: key instanceof CryptoKey, remembered: remembered.has(key), extractable: key.extractable,
  verified: await provider.verify("HMAC", key, signature, data),
  exportError: await rejection(() => provider.exportKey("raw", key)),
  algorithmError: await rejection(() => provider.sign("AES-GCM", key, data)),
}));
