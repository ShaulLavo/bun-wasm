import { Stats, fstatSync, openSync, closeSync, statSync, writeFileSync } from "node:fs";

// fs.Stats as Bun builds it: callable with or without new, Node's argument order, Bun's
// field order, prototype date accessors that cache a Date built from the *Ms field, and
// a separate BigIntStats prototype.
type Fields = Record<string, unknown>;
const StatsAny = Stats as unknown as { (...args: unknown[]): Fields; new (...args: unknown[]): Fields; prototype: object };
const args = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const show = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? `${item}n` : item);

const created = new StatsAny(...args);
const called = StatsAny(...args);
console.log("new keys", Object.keys(created).join());
console.log("new values", show(created));
console.log("call values", show(called));
console.log("shared prototype", Object.getPrototypeOf(created) === Stats.prototype, Object.getPrototypeOf(called) === Stats.prototype, created instanceof Stats, called instanceof Stats);
console.log("name and length", Stats.name, Stats.length);
console.log("prototype names", Object.getOwnPropertyNames(Stats.prototype).join());
const atimeDescriptor = Object.getOwnPropertyDescriptor(Stats.prototype, "atime")!;
console.log("atime accessor", typeof atimeDescriptor.get, typeof atimeDescriptor.set, atimeDescriptor.enumerable, atimeDescriptor.configurable);
const isFileDescriptor = Object.getOwnPropertyDescriptor(Stats.prototype, "isFile")!;
console.log("isFile method", isFileDescriptor.enumerable, isFileDescriptor.writable, isFileDescriptor.configurable);

// Dates come from the *Ms fields and are cached as own properties on first read.
console.log("dates", created.atime instanceof Date, (created.atime as Date).getTime(), (created.birthtime as Date).getTime());
console.log("keys after reading atime", Object.keys(created).slice(-2).join());
const empty = new StatsAny();
console.log("no arguments", show(empty), Number.isNaN((empty.atime as Date).getTime()));
const later = new StatsAny();
later.atimeMs = 0;
console.log("first read", (later.atime as Date).getTime());
later.atimeMs = 5000;
console.log("cached read", (later.atime as Date).getTime());
const assigned = new StatsAny(...args);
const date = new Date(42);
assigned.atime = date;
console.log("assigned date", assigned.atime === date, Object.keys(assigned).at(-1));

// Methods and accessors give undefined for a receiver that is not an object.
const { isFile } = statSync(".") as unknown as { isFile(): unknown };
const atime = atimeDescriptor.get!;
console.log("detached", isFile(), isFile.call(1), atime.call(undefined), atime.call("text"));
console.log("plain receiver", (Stats.prototype as { isFile(): boolean }).isFile.call({ mode: 0o100644 }), (atime.call({ atimeMs: 5 }) as Date).getTime());

// Subclasses construct through new.target.
class Sub extends (Stats as unknown as new (...args: unknown[]) => Fields) {}
const sub = new Sub(7, 0o40755);
console.log("subclass", sub instanceof Sub, sub instanceof Stats, sub.dev, (sub as unknown as { isDirectory(): boolean }).isDirectory());

// statSync, fstatSync and bigint results share the same prototypes and field order.
writeFileSync("f.txt", "hello");
const stats = statSync("f.txt");
console.log("stat keys", Object.keys(stats).join(), stats instanceof Stats, stats.isFile());
const fd = openSync("f.txt", "r");
console.log("fstat", fstatSync(fd) instanceof Stats, fstatSync(fd).size);
closeSync(fd);
const big = statSync("f.txt", { bigint: true });
const BigIntStats = Object.getPrototypeOf(big).constructor as { name: string; prototype: object };
console.log("bigint keys", Object.keys(big).join());
console.log("bigint prototype", BigIntStats.name, big instanceof Stats, Object.getPrototypeOf(BigIntStats.prototype) === Object.prototype, typeof big.size, big.isFile());
console.log("bigint dates", big.mtime.getTime() === Number(big.mtimeMs), big.mtimeNs / 1_000_000n === big.mtimeMs);
const madeBig = new (BigIntStats as unknown as new (...args: bigint[]) => Fields)(1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11_000_000n, -1_500_000n, 13n, 14n);
console.log("bigint constructor", show(madeBig));
try {
  void madeBig.atime;
} catch (error) {
  console.log("bigint constructor date", (error as Error).name);
}

// fstatSync validates the descriptor like Bun.
for (const value of [1.0, -1, Number.POSITIVE_INFINITY, 2_147_483_648, 2_147_483_647]) {
  try {
    fstatSync(value);
    console.log("fstat", value, "ok");
  } catch (error) {
    console.log("fstat", value, (error as { code: string }).code);
  }
}
