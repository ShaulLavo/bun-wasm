import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildScript } from "./tls-probe-cargo.ts";

export function run(command: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n> ${command.join(" ")}`);
  const result = spawnSync(command[0]!, command.slice(1), { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${result.signal ?? result.status}`);
}

type BlockingCryptoProof = {
  build: BuildScript;
  archives: { ssl: { path: string; sha256: string; bytes: number }; crypto: { path: string; sha256: string; bytes: number } };
};

async function runBlockingCryptoBuild(command: readonly string[], env: NodeJS.ProcessEnv): Promise<BlockingCryptoProof> {
  console.log(`\n> ${command.join(" ")}`);
  const { CargoTlsMessages } = await import("./tls-probe-cargo.ts");
  const { fileIdentity } = await import("./tls-probe-inputs.ts");
  const workspace = realpathSync(env.GITHUB_WORKSPACE ?? process.cwd());
  const prefix = `path+${pathToFileURL(join(workspace, "crates/bunwasm-crypto-sys")).href}#`;
  const messages = new CargoTlsMessages(prefix, text => process.stdout.write(text));
  const separator = command.indexOf("--");
  const at = separator < 0 ? command.length : separator;
  const args = command.slice(1, at).concat(["--message-format=json-render-diagnostics"], command.slice(at));
  const child = spawn(command[0]!, args, { env, stdio: ["inherit", "pipe", "inherit"] });
  child.stdout.on("data", (chunk: Buffer) => messages.feed(chunk));
  const result = await new Promise<{ status: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${result.signal ?? result.status}`);
  const build = messages.end();
  const directory = join(realpathSync(build.outDir), "boringssl");
  return {
    build,
    archives: {
      ssl: await fileIdentity(join(directory, "libssl.a")),
      crypto: await fileIdentity(join(directory, "libcrypto.a")),
    },
  };
}

export function verifyRecordedCryptoMatch(recordPath: string, blocking: BlockingCryptoProof): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
    const output = (parsed as { output?: { build?: unknown; files?: { path: string; sha256: string; bytes: number }[] } })?.output;
    assert.ok(output && Array.isArray(output.files), "Malformed TLS Cargo record output");
    const files: { path: string; sha256: string; bytes: number }[] = output.files;
    assert.deepEqual(output.build, blocking.build, "Scoped TLS Cargo record built a different bunwasm-crypto-sys out_dir than the blocking pass");
    for (const expected of [blocking.archives.ssl, blocking.archives.crypto]) {
      const matched = files.find(file => file.path === expected.path);
      assert.deepEqual(matched, expected, `Scoped TLS Cargo archive mismatch for ${expected.path}`);
    }
  } catch (error) {
    rmSync(recordPath, { force: true });
    throw error;
  }
}

export async function runCargoVerified(
  blockingCommand: string[],
  recordCommand: string[],
  abi: "host" | "wasm32-wasip1",
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const recordDir = env.BUNWASM_TLS_CARGO_RECORD_DIR;
  if (!recordDir) { run(blockingCommand, env); return; }
  const blocking = await runBlockingCryptoBuild(blockingCommand, env);
  console.log(`\n> ${recordCommand.join(" ")}`);
  const { recordCargo } = await import("./tls-probe-cargo.ts");
  await recordCargo(recordCommand, abi, env);
  verifyRecordedCryptoMatch(join(recordDir, `${abi}.json`), blocking);
}
