// A CryptoKey lists its usages in WebCrypto's KeyUsage order, whatever order the caller gave.
const subtle = crypto.subtle;
const show = (label: string, usages: readonly string[]) => console.log(label, JSON.stringify(usages));

const forward = await subtle.importKey("raw", new Uint8Array(32), { name: "AES-CBC" }, true, ["encrypt", "decrypt"]);
const reversed = await subtle.importKey("raw", new Uint8Array(32), { name: "AES-CBC" }, true, ["decrypt", "encrypt"]);
show("AES-CBC forward", forward.usages);
show("AES-CBC reversed", reversed.usages);
show("AES-CBC jwk key_ops", (await subtle.exportKey("jwk", reversed)).key_ops ?? []);

const aesKw = await subtle.importKey("raw", new Uint8Array(16), { name: "AES-KW" }, false, ["unwrapKey", "wrapKey"]);
show("AES-KW", aesKw.usages);
const hmac = await subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, true, ["verify", "sign"]);
show("HMAC", hmac.usages);
const generated = await subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["unwrapKey", "decrypt", "wrapKey", "encrypt", "decrypt"]);
show("AES-GCM generated", (generated as CryptoKey).usages);

const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
show("ECDH private", ecdh.privateKey.usages);
show("ECDH public", ecdh.publicKey.usages);
const ecdsa = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["verify", "sign"]);
show("ECDSA private", ecdsa.privateKey.usages);
show("ECDSA public", ecdsa.publicKey.usages);

const derived = await subtle.deriveKey({ name: "ECDH", public: ecdh.publicKey }, ecdh.privateKey, { name: "AES-GCM", length: 128 }, true, ["decrypt", "encrypt"]);
show("derived AES-GCM", derived.usages);
const pbkdf2 = await subtle.importKey("raw", new Uint8Array(8), "PBKDF2", false, ["deriveBits", "deriveKey"]);
show("PBKDF2", pbkdf2.usages);
