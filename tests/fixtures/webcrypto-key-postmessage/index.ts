// CryptoKeys sent to a Worker with postMessage and back: the receiving side gets usable
// keys with the same algorithm, type, extractability and usages, as in Bun. The browser
// engine delegates WebCrypto to its host, so this fixture skips it.
const subtle = crypto.subtle;
const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");
const material = new Uint8Array(32).fill(9);
const chacha = await subtle.importKey("raw-secret", material, "ChaCha20-Poly1305", true, ["encrypt", "decrypt"]);
const aes = await subtle.importKey("raw", new Uint8Array(16).fill(4), "AES-GCM", false, ["encrypt"]);
const dsa = await subtle.importKey("raw-seed", new Uint8Array(32).fill(2), "ML-DSA-44", true, ["sign"]);
const dsaPublic = await subtle.getPublicKey(dsa, ["verify"]);
const rsa = (await subtle.generateKey(
  { name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;

const worker = new Worker(
  URL.createObjectURL(
    new Blob(
      [
        `self.onmessage = async ({ data }) => {
          const subtle = crypto.subtle;
          const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
          const describe = key => [key instanceof CryptoKey, key.type, key.extractable, JSON.stringify(key.usages), JSON.stringify({ ...key.algorithm, publicExponent: key.algorithm.publicExponent && Array.from(key.algorithm.publicExponent) })].join(" ");
          const report = {
            chacha: describe(data.chacha) + " " + hex(await subtle.exportKey("raw-secret", data.chacha)),
            aes: describe(data.aes) + " " + (await subtle.exportKey("raw", data.aes).then(() => "exported", e => e.name)),
            dsa: describe(data.dsa) + " " + hex(await subtle.exportKey("raw-seed", data.dsa)).slice(0, 16),
            dsaPublic: describe(data.dsaPublic) + " " + (await subtle.exportKey("spki", data.dsaPublic)).byteLength,
            rsa: describe(data.rsa),
            sameObject: data.chacha === data.again,
          };
          const iv = new Uint8Array(12);
          const sealed = await subtle.encrypt({ name: "ChaCha20-Poly1305", iv }, data.chacha, new Uint8Array([1, 2, 3]));
          const signature = await subtle.sign("ML-DSA-44", data.dsa, new Uint8Array([7]));
          postMessage({ report, sealed, signature, key: data.chacha, generated: await subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 64 }, true, ["sign"]) });
        };`,
      ],
      { type: "application/javascript" },
    ),
  ),
);
const reply = await new Promise<any>((resolve, reject) => {
  worker.onmessage = event => resolve(event.data);
  worker.onerror = event => reject(new Error(event.message));
  worker.postMessage({ chacha, aes, dsa, dsaPublic, rsa: rsa.privateKey, again: chacha });
});
worker.terminate();
for (const [name, line] of Object.entries(reply.report)) console.log("worker", name, line);
const opened = await subtle.decrypt({ name: "ChaCha20-Poly1305", iv: new Uint8Array(12) }, chacha, reply.sealed);
console.log("main decrypts worker ciphertext", hex(opened));
console.log("main verifies worker signature", await subtle.verify("ML-DSA-44", dsaPublic, reply.signature, new Uint8Array([7])));
console.log("key back from worker", reply.key instanceof CryptoKey, reply.key.algorithm.name, hex(await subtle.exportKey("raw-secret", reply.key)) === hex(material.buffer));
console.log("generated in worker", reply.generated instanceof CryptoKey, JSON.stringify(reply.generated.algorithm), (await subtle.exportKey("raw", reply.generated)).byteLength);
