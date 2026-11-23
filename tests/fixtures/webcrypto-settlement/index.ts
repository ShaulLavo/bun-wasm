// SubtleCrypto methods brand-check their receiver and settle a completed operation in a
// later task, after microtasks that were already queued, as in the Web Crypto spec and Bun.
const subtle = crypto.subtle;
const bytes = new Uint8Array(1 << 16).fill(7);

async function rejection(promise: unknown) {
  if (!(promise instanceof Promise)) return `returned ${typeof promise}`;
  try {
    await promise;
    return "fulfilled";
  } catch (error) {
    const e = error as Error & { code?: string };
    return `${e.name}: ${e.message}${e.code ? ` (${e.code})` : ""}`;
  }
}

const { digest } = subtle;
console.log("detached digest:", await rejection(Reflect.apply(digest, undefined, ["SHA-256", bytes])));
console.log("forged digest:", await rejection(Reflect.apply(digest, Object.create(SubtleCrypto.prototype), ["SHA-256", bytes])));
console.log("forged sign:", await rejection(Reflect.apply(subtle.sign, {}, ["HMAC", null, bytes])));

const key = await subtle.importKey("raw", new Uint8Array(32).fill(1), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const hmac = await subtle.importKey("raw", new Uint8Array(32).fill(2), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const iv = new Uint8Array(12);
const operations: [string, () => Promise<unknown>][] = [
  ["digest SHA-256", () => subtle.digest("SHA-256", bytes)],
  ["digest SHA3-256", () => subtle.digest("SHA3-256", bytes)],
  ["encrypt AES-GCM", () => subtle.encrypt({ name: "AES-GCM", iv }, key, bytes)],
  ["sign HMAC", () => subtle.sign("HMAC", hmac, bytes)],
  ["generateKey HMAC", () => subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"])],
];
for (const [label, start] of operations) {
  const order: string[] = [];
  const pending = start().then(() => order.push("result"));
  queueMicrotask(() => order.push("microtask"));
  await pending;
  console.log(`${label}:`, order.join(" then "));
}

const sealed = await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
const opened = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, sealed));
console.log("round trip:", opened.length === bytes.length && opened.every(value => value === 7));
const tampered = new Uint8Array(sealed);
tampered[0] ^= 1;
console.log("tampered:", await rejection(subtle.decrypt({ name: "AES-GCM", iv }, key, tampered)));
const signature = await subtle.sign("HMAC", hmac, bytes);
console.log("verify:", await subtle.verify("HMAC", hmac, signature, bytes), await subtle.verify("HMAC", hmac, signature, iv));
console.log("bad iv:", await rejection(subtle.encrypt({ name: "AES-CBC", iv }, key, bytes)));

// Failures settle like results: computation failures in a later task, argument errors at once.
async function order(label: string, start: () => Promise<unknown>) {
  const seen: string[] = [];
  const pending = start().then(() => seen.push("result"), (error: Error) => seen.push(`${error.name}`));
  queueMicrotask(() => seen.push("microtask"));
  await pending;
  console.log(`${label}:`, seen.join(" then "));
}
const ctr = await subtle.importKey("raw", new Uint8Array(16), "AES-CTR", true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
const cbc = await subtle.importKey("raw", new Uint8Array(32).fill(3), "AES-CBC", true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
const gcmWrap = await subtle.importKey("raw", new Uint8Array(32).fill(4), "AES-GCM", true, ["wrapKey", "unwrapKey"]);
const kw = await subtle.importKey("raw", new Uint8Array(16).fill(5), "AES-KW", true, ["wrapKey", "unwrapKey"]);
const secret = await subtle.importKey("raw", new Uint8Array(32).fill(6), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const block = new Uint8Array(16);
await order("decrypt bad tag", () => subtle.decrypt({ name: "AES-GCM", iv }, key, tampered));
await order("encrypt empty GCM iv", () => subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(0) }, key, bytes));
await order("encrypt 12-byte CTR counter", () => subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, ctr, bytes));
const wrapCases: [string, CryptoKey, AlgorithmIdentifier | AesGcmParams | AesCbcParams | AesCtrParams][] = [
  ["AES-KW", kw, "AES-KW"],
  ["AES-GCM", gcmWrap, { name: "AES-GCM", iv }],
  ["AES-CBC", cbc, { name: "AES-CBC", iv: block }],
  ["AES-CTR", ctr, { name: "AES-CTR", counter: block, length: 64 }],
];
for (const [name, wrapping, params] of wrapCases) {
  const wrapped = await subtle.wrapKey("raw", secret, wrapping, params);
  await order(`wrapKey ${name}`, () => subtle.wrapKey("raw", secret, wrapping, params));
  await order(`unwrapKey ${name}`, () => subtle.unwrapKey("raw", wrapped, wrapping, params, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
}

// The bytes of a call are its bytes at the call: changing or detaching them afterwards
// changes nothing, and a bad tag fails without being computed twice.
const changed = new Uint8Array(tampered);
const pendingChanged = subtle.decrypt({ name: "AES-GCM", iv }, key, changed);
changed.set(new Uint8Array(sealed));
console.log("bad tag, then repaired:", await rejection(pendingChanged));
const detached = new Uint8Array(tampered);
const pendingDetached = subtle.decrypt({ name: "AES-GCM", iv }, key, detached);
structuredClone(detached.buffer, { transfer: [detached.buffer] });
console.log("bad tag, then detached:", await rejection(pendingDetached));

// AES-CTR whose 2-bit counter field wraps after one block (the field restarts at zero).
const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");
const wrapCounter = new Uint8Array(16);
wrapCounter[15] = 3;
const zero = await subtle.importKey("raw", new Uint8Array(16), "AES-CTR", false, ["encrypt", "decrypt"]);
const wrapParams = { name: "AES-CTR", counter: wrapCounter, length: 2 };
const wrappedCtr = await subtle.encrypt(wrapParams, zero, new Uint8Array(32));
console.log("CTR wrap encrypt:", hex(wrappedCtr));
console.log("CTR wrap decrypt:", hex(await subtle.decrypt(wrapParams, zero, wrappedCtr)));

// WebCrypto ECDSA signatures are IEEE P1363 whatever the dictionary carries.
const ec = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
const ecdsa = { name: "ECDSA", hash: "SHA-256", der: true } as EcdsaParams;
const ecSignature = await subtle.sign(ecdsa, ec.privateKey, bytes);
console.log("ECDSA with der:", ecSignature.byteLength, await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, ecSignature, bytes));
