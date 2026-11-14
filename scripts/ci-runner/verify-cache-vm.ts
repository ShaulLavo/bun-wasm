import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { root } from "./host.ts";

const key = "pc-runner-qualification-v1";
const snapshot = createHash("sha256").update(JSON.stringify([key, "target"])).digest("hex");
const environment = `export GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=ShaulLavo/bun-wasm CACHE_PATHS=target CACHE_KEY=${key} CACHE_RESTORE_KEYS='' GITHUB_OUTPUT=/work/t/cache-output; `;

async function vm(script: string): Promise<string> {
  const child = spawn(`${root}/bin/bun`, [new URL("./vm.ts", import.meta.url).pathname, "run", "native", "--", "/bin/bash", "-euc", environment + script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
  if (code !== 0) throw new Error("Guest warm-cache proof failed");
  return output;
}

async function main(): Promise<void> {
  let cleanup = false;
  try {
    const save = await vm("mkdir -p target; printf original-stamp >target/stamp; touch -d '@1700000000.123456789' target/stamp; node /opt/bun-wasm-ci/cache.ts save; echo CACHE_SAVED");
    const restore = await vm(`node /opt/bun-wasm-ci/cache.ts restore; grep -qx 'cache-hit=true' /work/t/cache-output; test "$(cat target/stamp)" = original-stamp; test "$(stat -c %y target/stamp)" = '2023-11-14 22:13:20.123456789 +0000'; rm -r -- ${root}/cache/snapshots-v1/${snapshot}; echo CACHE_RESTORED_WITH_UNCHANGED_STAMP`);
    cleanup = true;
    await writeFile("/work/reports/goals/ci-speed-20261114/vm-cache-proof.json", JSON.stringify({ key, save, restore, qualificationSnapshotRemoved: true }, null, 2));
  } finally {
    if (!cleanup) await vm(`rm -rf -- ${root}/cache/snapshots-v1/${snapshot}`);
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "VM cache proof failed"}\n`); process.exitCode = 1; });
