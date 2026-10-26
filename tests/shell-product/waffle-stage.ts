import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparationFlow } from "./prepare-flow";

export const networkFiles = ["network.wasm", "network.sha256", "network.input-hash"] as const;
export const waffleSelectionFile = ".shell-product-host.json";
export type WaffleCommits = { shellCommit: string; wafflePeerCommit: string; waffleHostCommit: string };
export type WaffleSelection = WaffleCommits & { networkInputHash: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fullCommit(value: unknown, name: string) {
  assert.ok(typeof value === "string", `Set full ${name}`);
  assert.match(value, /^[a-f0-9]{40}$/, `Set full ${name}`);
  return value;
}
function networkHash(value: unknown) {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Invalid network input hash");
  return value;
}
function selection(value: unknown): WaffleSelection {
  assert.ok(isRecord(value), "Invalid retained Waffle selection");
  return {
    shellCommit: fullCommit(value.shellCommit, "retained shellCommit"),
    wafflePeerCommit: fullCommit(value.wafflePeerCommit, "retained wafflePeerCommit"),
    waffleHostCommit: fullCommit(value.waffleHostCommit, "retained waffleHostCommit"),
    networkInputHash: networkHash(value.networkInputHash),
  };
}
async function installedNetworkHash(installation: string) {
  return networkHash(await readFile(join(installation, "node_modules/waffle/browser/net/network.input-hash"), "utf8"));
}
export function waffleCommits(environment: NodeJS.ProcessEnv): WaffleCommits {
  const shellCommit = fullCommit(environment.SHELL_PRODUCT_SHELL_COMMIT, "SHELL_PRODUCT_SHELL_COMMIT");
  const wafflePeerCommit = fullCommit(environment.SHELL_PRODUCT_WAFFLE_COMMIT, "SHELL_PRODUCT_WAFFLE_COMMIT");
  const waffleHostCommit = fullCommit(environment.SHELL_PRODUCT_WAFFLE_HOST_COMMIT ?? wafflePeerCommit, "SHELL_PRODUCT_WAFFLE_HOST_COMMIT");
  return { shellCommit, wafflePeerCommit, waffleHostCommit };
}
export async function writeWaffleSelection(installation: string, commits: WaffleCommits) {
  const value = selection({ ...commits, networkInputHash: await installedNetworkHash(installation) });
  await writeFile(join(installation, waffleSelectionFile), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
export async function readWaffleSelection(installation: string, commits: WaffleCommits) {
  const expected = selection({ ...commits, networkInputHash: await installedNetworkHash(installation) });
  const stored: unknown = JSON.parse(await readFile(join(installation, waffleSelectionFile), "utf8"));
  const actual = selection(stored);
  assert.deepEqual(actual, expected, "Retained Waffle selection does not match requested Shell, peer, host, and network inputs");
  return actual;
}

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
