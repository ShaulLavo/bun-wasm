// MEM02 stage 1: Bun's strings must stay correct at addresses above the old 512 MiB boundary.
// Transpile and bundle Latin-1, UTF-8 and UTF-16 sources, fill the guest past 600 MiB with live
// ballast, then repeat: the outputs must be byte-identical. Run on QuickJS and on JSC separately.
// Linear memory beyond 512 MiB is checked through rss; the address of each Bun string is not.
const MiB = 2 ** 20;
const sources = ["latin1", "utf8", "utf16"].map((name) => `./src/${name}.ts`);

async function outputs(): Promise<string[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const transpiled = await Promise.all(sources.map(async (path) => transpiler.transformSync(await Bun.file(path).text())));
  const built = await Bun.build({ entrypoints: ["./src/entry.ts"], target: "browser" });
  if (!built.success) throw new AggregateError(built.logs, "build failed");
  return transpiled.concat(await Promise.all(built.outputs.map((output) => output.text())));
}

const before = await outputs();
const ballast: Uint8Array[] = [];
while (process.memoryUsage().rss < 600 * MiB) {
  const block = new Uint8Array(16 * MiB);
  block.fill(ballast.length & 0xff);
  ballast.push(block);
}
console.log("memory above 512 MiB", process.memoryUsage().rss > 512 * MiB);
const after = await outputs();
console.log("outputs", after.length, "identical", after.every((text, index) => text === before[index]));
console.log("ballast intact", ballast.every((block, index) => block[block.length - 1] === (index & 0xff)));
console.log(after.at(-1)!.includes("🦊🚀") && after.at(-1)!.includes("東京") && after.at(-1)!.includes("café"));
