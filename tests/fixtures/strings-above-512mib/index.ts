// MEM02 stage 1: Bun's strings must work at addresses above the old 512 MiB boundary, where
// wasm32 pointer tags used to corrupt them. Blocking on QuickJS (native checks) and JSC
// (scripts/jsc-embedding.ts). The guest's linear memory maximum is 1 GiB.
import { createHash } from "node:crypto";
import { bunStringRoundTrip, linearMemoryBytes } from "bun:internal-for-testing";

const MiB = 2 ** 20;
const BOUNDARY = 2 ** 29;
const sources = ["latin1", "utf8", "utf16"].map((name) => `./src/${name}.ts`);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function outputs(): Promise<string[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const transpiled = await Promise.all(sources.map(async (path) => transpiler.transformSync(await Bun.file(path).text())));
  const built = await Bun.build({ entrypoints: ["./src/entry.ts"], target: "browser" });
  if (!built.success) throw new AggregateError(built.logs, "build failed");
  return transpiled.concat(await Promise.all(built.outputs.map((output) => output.text())));
}

const before = await outputs();

// Live ballast in 16 MiB blocks until memory passes 560 MiB. The core and the engine allocate
// from one linear memory and one malloc, so the core reads that memory's size; engines report
// process.memoryUsage().rss differently (JSC reports null). The allocator gives each block the
// smallest free chunk that fits, so afterwards no free chunk below the ballast reaches 16 MiB.
const ballast: Uint8Array[] = [];
while (linearMemoryBytes() < 560 * MiB) {
  const block = new Uint8Array(16 * MiB);
  block.fill(ballast.length & 0xff);
  ballast.push(block);
}
console.log("memory above 512 MiB", linearMemoryBytes() > 512 * MiB);

// Each payload is larger than any hole left below the ballast, so Bun's String is built over
// fresh memory past it and decoded through EncodedSlice there.
const size = 17 * MiB;
const payloads = {
  latin1: Buffer.from("café crème ".repeat(size / 11 + 1), "latin1"),
  utf8: Buffer.from("東京 ✓ café ".repeat(size / 16 + 1), "utf8"),
  utf16le: Buffer.from("🦊é".repeat(size / 6 + 1), "utf16le"),
};
for (const [encoding, bytes] of Object.entries(payloads)) {
  const result = bunStringRoundTrip(bytes, encoding);
  console.log(encoding, "above 512 MiB", result.address >= BOUNDARY, "identical", digest(result.bytes) === digest(bytes));
}

const after = await outputs();
console.log("outputs", after.length, "identical", after.every((text, index) => text === before[index]));
console.log("ballast intact", ballast.every((block, index) => block[block.length - 1] === (index & 0xff)));
