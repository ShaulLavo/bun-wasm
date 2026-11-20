import crypto from "node:crypto";

// node:crypto checkPrime and generatePrime: known primes and composites, generated primes
// with their options, and Node's argument checks with native Bun's messages.
const describe = (value: unknown) =>
  value instanceof ArrayBuffer ? `ArrayBuffer ${value.byteLength}` : value instanceof Uint8Array ? `${value.constructor.name} ${Buffer.from(value).toString("hex")}` : typeof value === "bigint" ? `${value}n` : String(value);
const show = (label: string, make: () => unknown) => {
  try {
    console.log(label, describe(make()));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};
const bits = (value: bigint) => value.toString(2).length;

const candidates: [string, bigint][] = [
  ["0", 0n],
  ["1", 1n],
  ["2", 2n],
  ["3", 3n],
  ["4", 4n],
  ["561 carmichael", 561n],
  ["mersenne 61", 2n ** 61n - 1n],
  ["mersenne 67 composite", 2n ** 67n - 1n],
  ["mersenne 127", 2n ** 127n - 1n],
  ["2^255-19", 2n ** 255n - 19n],
  ["2^255-21", 2n ** 255n - 21n],
];
for (const [label, value] of candidates) {
  show(`checkPrimeSync ${label}`, () => crypto.checkPrimeSync(value));
}
show("checkPrimeSync buffer", () => crypto.checkPrimeSync(Buffer.from([0x00, 0x00, 0x00, 0x07])));
show("checkPrimeSync arraybuffer", () => crypto.checkPrimeSync(new Uint8Array([0xfb]).buffer));
show("checkPrimeSync dataview", () => crypto.checkPrimeSync(new DataView(new Uint8Array([0x09]).buffer)));
show("checkPrimeSync checks", () => crypto.checkPrimeSync(2n ** 89n - 1n, { checks: 10 }));
show("checkPrimeSync negative bigint", () => crypto.checkPrimeSync(-7n));
show("checkPrimeSync number", () => crypto.checkPrimeSync(7 as never));
show("checkPrimeSync string", () => crypto.checkPrimeSync("7" as never));
show("checkPrimeSync bad checks", () => crypto.checkPrimeSync(7n, { checks: -1 }));
show("checkPrimeSync string checks", () => crypto.checkPrimeSync(7n, { checks: "1" } as never));
show("checkPrimeSync bad options", () => crypto.checkPrimeSync(7n, 5 as never));

for (const size of [2, 3, 8, 16, 64, 128]) {
  show(`generatePrimeSync ${size}`, () => {
    const prime = crypto.generatePrimeSync(size, { bigint: true });
    return `${bits(prime)} ${crypto.checkPrimeSync(prime)}`;
  });
}
show("generatePrimeSync arraybuffer", () => {
  const prime = crypto.generatePrimeSync(64);
  return `${prime instanceof ArrayBuffer} ${prime.byteLength} ${crypto.checkPrimeSync(prime)}`;
});
show("generatePrimeSync safe", () => {
  const prime = crypto.generatePrimeSync(64, { safe: true, bigint: true });
  return `${bits(prime)} ${crypto.checkPrimeSync(prime)} ${crypto.checkPrimeSync((prime - 1n) / 2n)}`;
});
show("generatePrimeSync add rem", () => {
  const prime = crypto.generatePrimeSync(32, { add: 12n, rem: 11n, bigint: true });
  return `${bits(prime)} ${prime % 12n} ${crypto.checkPrimeSync(prime)}`;
});
// An add without a rem never finishes in native Bun, so every case here passes both.
show("generatePrimeSync add buffer", () => {
  const prime = crypto.generatePrimeSync(32, { add: Buffer.from([10]), rem: new Uint8Array([3]), bigint: true });
  return `${bits(prime)} ${prime % 10n} ${crypto.checkPrimeSync(prime)}`;
});
show("generatePrimeSync safe add", () => {
  const prime = crypto.generatePrimeSync(32, { safe: true, add: 12n, rem: 11n, bigint: true });
  return `${bits(prime)} ${prime % 12n} ${crypto.checkPrimeSync(prime)}`;
});
show("generatePrimeSync size 1", () => crypto.generatePrimeSync(1));
show("generatePrimeSync size 0", () => crypto.generatePrimeSync(0));
show("generatePrimeSync size fraction", () => crypto.generatePrimeSync(8.5));
show("generatePrimeSync size string", () => crypto.generatePrimeSync("8" as never));
show("generatePrimeSync add too big", () => crypto.generatePrimeSync(8, { add: 1024n }));
show("generatePrimeSync rem not below add", () => crypto.generatePrimeSync(32, { add: 12n, rem: 12n }));
show("generatePrimeSync add number", () => crypto.generatePrimeSync(32, { add: 12 } as never));
show("generatePrimeSync rem string", () => crypto.generatePrimeSync(32, { rem: "1" } as never));
show("generatePrimeSync safe not boolean", () => crypto.generatePrimeSync(32, { safe: 1 } as never));
show("generatePrimeSync bigint not boolean", () => crypto.generatePrimeSync(32, { bigint: "yes" } as never));
show("generatePrimeSync bad options", () => crypto.generatePrimeSync(32, 5 as never));

const asyncPrime = await new Promise<string>(resolve =>
  crypto.generatePrime(48, { bigint: true }, (error, prime) => resolve(`${error} ${typeof prime} ${bits(prime as bigint)} ${crypto.checkPrimeSync(prime as bigint)}`)),
);
console.log("generatePrime callback", asyncPrime);
const asyncBuffer = await new Promise<string>(resolve => crypto.generatePrime(32, (error, prime) => resolve(`${error} ${prime instanceof ArrayBuffer} ${prime.byteLength}`)));
console.log("generatePrime no options", asyncBuffer);
const asyncCheck = await new Promise<string>(resolve => crypto.checkPrime(2n ** 61n - 1n, (error, result) => resolve(`${error} ${result}`)));
console.log("checkPrime callback", asyncCheck);
const asyncCheckOptions = await new Promise<string>(resolve => crypto.checkPrime(Buffer.from([0x0f]), { checks: 3 }, (error, result) => resolve(`${error} ${result}`)));
console.log("checkPrime options callback", asyncCheckOptions);
show("generatePrime no callback", () => crypto.generatePrime(8, {} as never, undefined as never));
show("checkPrime no callback", () => crypto.checkPrime(7n, undefined as never));
show("generatePrime bad size", () => crypto.generatePrime(-1, () => {}));
let order = "sync";
crypto.checkPrime(7n, () => console.log("checkPrime runs after", order));
order = "later";
console.log("names", crypto.generatePrime.name, crypto.generatePrimeSync.name, crypto.checkPrime.name, crypto.checkPrimeSync.name);
