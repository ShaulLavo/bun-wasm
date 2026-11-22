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
