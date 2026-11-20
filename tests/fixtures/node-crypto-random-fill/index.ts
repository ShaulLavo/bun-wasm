import crypto from "node:crypto";

// randomFill and randomFillSync bounds in elements of the typed array (Node's
// lib/internal/crypto/random.js), checkPrime reading the candidate at call time,
// hkdf with a length of 0, and getRandomValues rejecting floating-point views.
const show = (label: string, run: () => unknown) => {
  try {
    const value = run();
    console.log(label, ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? `${value.constructor.name} ${value.byteLength}` : String(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};
show("sync no buffer", () => crypto.randomFillSync(undefined as never));
show("sync string", () => crypto.randomFillSync("abc" as never));
show("sync offset -1", () => crypto.randomFillSync(new Uint8Array(4), -1));
show("sync offset 5", () => crypto.randomFillSync(new Uint8Array(4), 5));
show("sync offset string", () => crypto.randomFillSync(new Uint8Array(4), "1" as never));
show("sync offset NaN", () => crypto.randomFillSync(new Uint8Array(4), NaN));
show("sync offset 1.5", () => crypto.randomFillSync(new Uint8Array(4), 1.5));
show("sync size 5", () => crypto.randomFillSync(new Uint8Array(4), 0, 5));
show("sync size -1", () => crypto.randomFillSync(new Uint8Array(4), 0, -1));
show("sync size 3 offset 2", () => crypto.randomFillSync(new Uint8Array(4), 2, 3));
show("sync Float64Array offset 2", () => {
  const filled = crypto.randomFillSync(new Float64Array(4), 2);
  return filled[0] === 0 && filled[1] === 0;
});
show("sync Float64Array offset 5", () => crypto.randomFillSync(new Float64Array(4), 5));
show("sync Float64Array size 3 offset 2", () => crypto.randomFillSync(new Float64Array(4), 2, 3));
show("sync ArrayBuffer", () => {
  const buffer = new ArrayBuffer(8);
  crypto.randomFillSync(buffer, 2, 2);
  const bytes = new Uint8Array(buffer);
  return bytes[0] === 0 && bytes[1] === 0 && bytes[4] === 0;
});
show("sync DataView", () => crypto.randomFillSync(new DataView(new ArrayBuffer(8)), 2, 2));
show("sync past 2**24", () => crypto.randomFillSync(new ArrayBuffer(2 ** 24 + 2), 2 ** 24 + 1, 2));
show("sync at 2**24", () => crypto.randomFillSync(new Uint8Array(2 ** 24 + 2), 2 ** 24 + 1, 1));
show("async no callback", () => crypto.randomFill(new Uint8Array(4) as never, undefined as never));
show("async callback number", () => crypto.randomFill(new Uint8Array(4), 0, 2, 5 as never));
show("async offset 9", () => crypto.randomFill(new Uint8Array(4), 9, () => {}));
show("async size 9", () => crypto.randomFill(new Uint8Array(4), 0, 9, () => {}));
await new Promise<void>(resolve =>
  crypto.randomFill(new Float64Array(10), 2, (error, buffer) => {
    console.log("async Float64Array offset 2", error, buffer[0], buffer[1]);
    resolve();
  }),
);
await new Promise<void>(resolve =>
  crypto.randomFill(new Uint8Array(0), (error, buffer) => {
    console.log("async empty", error, buffer.length);
    resolve();
  }),
);
await new Promise<void>(resolve =>
  crypto.randomFill(new Uint16Array(4), 1, 2, (error, buffer) => {
    console.log("async Uint16Array 1 2", error, buffer[0], buffer[3]);
    resolve();
  }),
);

const candidate = Buffer.from([7]);
let reads = 0;
const options = {
  get checks() {
    reads++;
    candidate[0] = 9;
    return 1;
  },
};
show("checkPrimeSync candidate at call time", () => `${crypto.checkPrimeSync(candidate, options)} ${reads}`);
candidate[0] = 7;
await new Promise<void>(resolve =>
  crypto.checkPrime(candidate, options, (error, result) => {
    console.log("checkPrime candidate at call time", error, result, reads);
    resolve();
  }),
);

for (const ikm of ["key", "", Buffer.from("key"), crypto.createSecretKey(Buffer.from("key"))] as const) {
  show("hkdfSync length 0", () => crypto.hkdfSync("sha256", ikm, "", "", 0));
}
await new Promise<void>(resolve =>
  crypto.hkdf("sha512", "key", "salt", "info", 0, (...args: unknown[]) => {
    const error = args[0] as Error;
    console.log("hkdf length 0", args.length, error.name, error.message, "code" in error);
    resolve();
  }),
);
show("hkdfSync length 1", () => Buffer.from(crypto.hkdfSync("sha256", "key", "salt", "info", 1)).toString("hex"));
for (const digest of ["sha3-256", "SHA3-384", "sha3-512"]) {
  show(`hkdfSync ${digest}`, () => Buffer.from(crypto.hkdfSync(digest, "key", "salt", "info", 8)).toString("hex"));
}

for (const make of [() => new Float16Array(4), () => new Float32Array(4), () => new DataView(new ArrayBuffer(4)), () => new Uint16Array(4)]) {
  const view = make();
  show(`getRandomValues ${view.constructor.name}`, () => crypto.getRandomValues(view as never) === view);
}
