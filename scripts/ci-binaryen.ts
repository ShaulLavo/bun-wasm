import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const binaryenPin = {
  release: "version_133",
  sha256: "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489",
  toolVersion: "wasm-opt version 133 (version_133)",
} as const;
const archiveName = `binaryen-${binaryenPin.release}-x86_64-linux.tar.gz`;

export async function verifyBinaryenArchive(path: string): Promise<void> {
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
  if (digest !== binaryenPin.sha256) throw new Error(`Binaryen archive checksum mismatch: ${path}`);
}

export async function installBinaryen(tools: string) {
  await mkdir(tools, { recursive: true });
  const stage = await mkdtemp(join(tools, ".binaryen-"));
  try {
    const archive = join(tools, archiveName);
    const cached = await Bun.file(archive).exists();
    const input = cached ? archive : join(stage, archiveName);
    if (!cached) {
      execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "15", "--max-time", "180",
        `https://github.com/WebAssembly/binaryen/releases/download/${binaryenPin.release}/${archiveName}`, "-o", input]);
    }
    await verifyBinaryenArchive(input);
    if (!cached) await rename(input, archive);
    const prefix = join(stage, "prefix");
    await mkdir(prefix);
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", prefix]);
    const executable = join(prefix, "bin/wasm-opt");
    const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
    if (version !== binaryenPin.toolVersion) throw new Error(`Unexpected Binaryen version: ${version}`);
    const help = execFileSync(executable, ["--help"], { encoding: "utf8" });
    if (!help.includes("--spill-pointers")) throw new Error("Binaryen lacks required --spill-pointers finalization");
    const destination = join(tools, "binaryen");
    await rm(destination, { recursive: true, force: true });
    await rename(prefix, destination);
    return { bin: join(destination, "bin"), cached, version, archiveSha256: binaryenPin.sha256 };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const tools = process.env.WASM_TOOLS;
  const githubPath = process.env.GITHUB_PATH;
  if (!tools || !githubPath) throw new Error("Set WASM_TOOLS and GITHUB_PATH for CI Binaryen setup");
  const result = await installBinaryen(tools);
  await appendFile(githubPath, `${result.bin}\n`);
  process.stdout.write(JSON.stringify(result) + "\n");
}
