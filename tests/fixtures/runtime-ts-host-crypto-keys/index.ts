import assert from "node:assert/strict";
import { createSecretKey, KeyObject } from "node:crypto";

const subtle = crypto.subtle;
if (process.env.BUNWASM_TEST === "1") {
  assert.equal(Object.hasOwn(subtle, "sign"), process.env.BUNWASM_TEST_HOST === "node");
}
const bytes = Uint8Array.of(1, 2, 3);
const key = await subtle.importKey("raw", new Uint8Array(32).fill(3), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
assert.equal(key.extractable, false);
const roundTrip = KeyObject.from(key).toCryptoKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
if (Object.hasOwn(subtle, "sign")) assert.equal(roundTrip, key);
else assert.notEqual(roundTrip, key);
const signature = await subtle.sign("HMAC", key, bytes);
assert(await subtle.verify("HMAC", key, signature, bytes));
await assert.rejects(subtle.exportKey("raw", key), { name: "InvalidAccessError" });
console.log("import, native identity, sign, verify, export rejection");

const portable = createSecretKey(new Uint8Array(32).fill(4)).toCryptoKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const [first, second] = await Promise.all([subtle.sign("HMAC", portable, bytes), subtle.sign("HMAC", portable, bytes)]);
assert.deepEqual(first, second);
assert(await subtle.verify("HMAC", portable, first, bytes));
console.log("portable key conversion shared by concurrent operations");

const salt = Uint8Array.of(7, 8), info = Uint8Array.of(9);
const derivationKey = createSecretKey(new Uint8Array(32).fill(5)).toCryptoKey("HKDF", false, ["deriveKey", "deriveBits"]);
const op = { name: "HKDF", hash: "SHA-256", salt, info };
const derived = await subtle.deriveKey(op, derivationKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
assert.equal(derived.extractable, false);
assert(await subtle.verify("HMAC", derived, await subtle.sign("HMAC", derived, bytes), bytes));
assert.equal((await subtle.deriveBits(op, derivationKey, 128)).byteLength, 16);
console.log("portable derivation and retained nonextractable key");

const wrapping = await subtle.generateKey({ name: "AES-KW", length: 128 }, false, ["wrapKey", "unwrapKey"]);
const exportable = await subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, true, ["sign", "verify"]);
const wrapped = await subtle.wrapKey("raw", exportable, wrapping, "AES-KW");
const unwrapped = await subtle.unwrapKey("raw", wrapped, wrapping, "AES-KW", { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
assert.equal(unwrapped.extractable, false);
assert(await subtle.verify("HMAC", unwrapped, await subtle.sign("HMAC", exportable, bytes), bytes));
console.log("generated wrapping key and retained unwrapped key");
