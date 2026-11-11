import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Options = {
  raw: string;
  output: string;
  cache: string;
  optimizer: string;
  flags: readonly string[];
};

const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function fileHash(path: string): Promise<string> {
  const digest = new Bun.CryptoHasher("sha256");
  for await (const bytes of Bun.file(path).stream()) digest.update(bytes);
  return digest.digest("hex");
}

function cachedOutput(cache: string, input: string): Uint8Array | undefined {
  try {
    const receipt: unknown = JSON.parse(readFileSync(join(cache, "receipt.json"), "utf8"));
    if (!receipt || typeof receipt !== "object" || !("input" in receipt) || !("output" in receipt) || receipt.input !== input) return;
    const bytes = readFileSync(join(cache, "bun-tools.wasm"));
    if (receipt.output === hash(bytes)) return bytes;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return;
    throw error;
  }
}

export async function optimizeTools(options: Options): Promise<void> {
  const start = performance.now();
  const input = hash(JSON.stringify({ raw: await fileHash(options.raw), optimizer: await fileHash(options.optimizer), flags: options.flags }));
  const cached = cachedOutput(options.cache, input);
  if (cached) {
    writeFileSync(options.output, cached);
    console.log(JSON.stringify({ toolsOptimizer: "verified reuse", bytes: cached.byteLength, ms: Math.round(performance.now() - start) }));
    return;
  }
  mkdirSync(options.cache, { recursive: true });
  const scratch = mkdtempSync(join(options.cache, "optimize-"));
  try {
    const artifact = join(scratch, "bun-tools.wasm");
    execFileSync(options.optimizer, options.flags.concat([options.raw, "-o", artifact]), { stdio: "inherit" });
    const output = await fileHash(artifact);
    copyFileSync(artifact, options.output);
    renameSync(artifact, join(options.cache, "bun-tools.wasm"));
    writeFileSync(join(options.cache, "receipt.json"), JSON.stringify({ input, output }) + "\n");
    console.log(JSON.stringify({ toolsOptimizer: "built", ms: Math.round(performance.now() - start) }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [raw, output, cache, separator, ...flags] = process.argv.slice(2);
  const optimizer = Bun.which("wasm-opt");
  if (!raw || !output || !cache || separator !== "--" || !flags.length || !optimizer) throw new Error("Usage: optimize-tools.ts RAW OUTPUT CACHE -- WASM_OPT_FLAGS...");
  await optimizeTools({ raw, output, cache, optimizer, flags });
}
