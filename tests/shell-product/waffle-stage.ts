import assert from "node:assert/strict";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PreparationFlow } from "./prepare-flow";

export const networkFiles = ["network.wasm", "network.sha256", "network.input-hash"] as const;
export function waffleSourcePlan(repository: string, commit: string, archive: string, destination: string, environment: NodeJS.ProcessEnv) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const env = { ...environment, WAFFLE_NETWORK_PREBUILT: "1" };
  return [
    { command: ["git", "-C", repository, "archive", "--format=tar", "--output", archive, commit], cwd: repository, env },
    { command: ["tar", "-xf", archive, "-C", destination], cwd: repository, env },
    { command: [process.execPath, "tooling/build-network.ts", "--verify"], cwd: destination, env },
    { command: [process.execPath, "prepare.ts"], cwd: destination, env },
  ];
}
export async function stageWaffle(flow: PreparationFlow, options: { repository: string; commit: string; archive: string; destination: string; prepared: string; env: NodeJS.ProcessEnv }) {
  const [archive, extract, verify, prepare] = waffleSourcePlan(options.repository, options.commit, options.archive, options.destination, options.env);
  assert.ok(archive && extract && verify && prepare);
  await flow.execute(archive.command, archive.cwd, archive.env);
  flow.check();
  await rm(options.destination, { recursive: true, force: true });
  await mkdir(options.destination, { recursive: true });
  await flow.execute(extract.command, extract.cwd, extract.env);
  for (const name of networkFiles) {
    flow.check();
    await cp(join(options.prepared, "browser/net", name), join(options.destination, "browser/net", name));
  }
  await flow.execute(verify.command, verify.cwd, verify.env);
  await flow.execute(prepare.command, prepare.cwd, prepare.env);
}
