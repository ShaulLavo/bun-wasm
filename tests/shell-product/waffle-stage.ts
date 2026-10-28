import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import release from "../../scripts/waffle-release-inputs.json";
import { prepareWaffleReleaseArchive } from "../../scripts/waffle-release-inputs";
import { restorePackedBun } from "./prepare-flow";
import type { PreparationFlow } from "./prepare-flow";

export const networkFiles = ["network.wasm", "network.sha256", "network.input-hash"] as const;
export const waffleSelectionFile = ".shell-product-host.json";
export type WaffleCommits = { wafflePeer: string; shellCommit: string; wafflePeerCommit: string; waffleHostCommit: string };
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
    wafflePeer: wafflePeer(value.wafflePeer),
    shellCommit: fullCommit(value.shellCommit, "retained shellCommit"),
    wafflePeerCommit: fullCommit(value.wafflePeerCommit, "retained wafflePeerCommit"),
    waffleHostCommit: fullCommit(value.waffleHostCommit, "retained waffleHostCommit"),
    networkInputHash: networkHash(value.networkInputHash),
  };
}
async function installedNetworkHash(installation: string) {
  return networkHash(await readFile(join(installation, "node_modules/waffle/browser/net/network.input-hash"), "utf8"));
}
function wafflePeer(value: unknown): string {
  assert.ok(typeof value === "string", "Set exact Waffle peer");
  assert.ok(value === release.url || /^git\+https:\/\/github\.com\/ShaulLavo\/waffle\.git#[a-f0-9]{40}$/.test(value), "Waffle peer must be the checked release or an exact historical Git package");
  return value;
}
export function waffleCommits(environment: NodeJS.ProcessEnv, peer?: string): WaffleCommits {
  const shellCommit = fullCommit(environment.SHELL_PRODUCT_SHELL_COMMIT, "SHELL_PRODUCT_SHELL_COMMIT");
  const requested = environment.SHELL_PRODUCT_WAFFLE_COMMIT === undefined ? undefined : fullCommit(environment.SHELL_PRODUCT_WAFFLE_COMMIT, "SHELL_PRODUCT_WAFFLE_COMMIT");
  const selectedPeer = wafflePeer(peer ?? (requested ? `git+https://github.com/ShaulLavo/waffle.git#${requested}` : release.url));
  const wafflePeerCommit = selectedPeer === release.url ? release.sourceCommit : selectedPeer.slice(selectedPeer.lastIndexOf("#") + 1);
  if (requested) assert.equal(requested, wafflePeerCommit, "Requested Waffle commit must match the exact package peer source");
  const waffleHostCommit = fullCommit(environment.SHELL_PRODUCT_WAFFLE_HOST_COMMIT ?? wafflePeerCommit, "SHELL_PRODUCT_WAFFLE_HOST_COMMIT");
  return { wafflePeer: selectedPeer, shellCommit, wafflePeerCommit, waffleHostCommit };
}

function gitMetadata(repository: string, revision: string): unknown {
  const result = Bun.spawnSync(["git", "-C", repository, "show", revision], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `Missing Waffle source manifest ${revision}`);
  return JSON.parse(result.stdout.toString());
}
export function waffleSourceRoot(repository: string, commit: string, gitPeer = false): "" | "packages/waffle" {
  fullCommit(commit, "Waffle source commit");
  const root = gitMetadata(repository, `${commit}:package.json`);
  if (isRecord(root) && root.name === "waffle" && root.private !== true) return "";
  assert.ok(!gitPeer, "A private workspace Git root is not an installable Waffle peer; use the published release archive");
  const child = gitMetadata(repository, `${commit}:packages/waffle/package.json`);
  assert.ok(isRecord(child) && child.name === "waffle" && child.private !== true, "Invalid Waffle source package");
  return "packages/waffle";
}

export async function stageReleasedWaffle(flow: PreparationFlow, options: { peer: string; archive: string; destination: string }) {
  flow.check();
  await prepareWaffleReleaseArchive(options.peer, options.archive);
  flow.check();
  await restorePackedBun(flow, options);
  const metadata: unknown = await Bun.file(join(options.destination, "package.json")).json();
  assert.ok(isRecord(metadata) && metadata.name === "waffle" && metadata.version === release.version, "Invalid released Waffle package");
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

export function waffleSourcePlan(repository: string, commit: string, archive: string, destination: string, environment: NodeJS.ProcessEnv, packagePath: "" | "packages/waffle" = "") {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const env = { ...environment, WAFFLE_NETWORK_PREBUILT: "1" };
  return [
    { command: ["git", "-C", repository, "archive", "--format=tar", "--output", archive, packagePath ? `${commit}:${packagePath}` : commit], cwd: repository, env },
    { command: ["tar", "-xf", archive, "-C", destination], cwd: repository, env },
    { command: [process.execPath, "tooling/build-network.ts", "--verify"], cwd: destination, env },
    { command: [process.execPath, "prepare.ts"], cwd: destination, env },
  ];
}
export async function stageWaffle(flow: PreparationFlow, options: { repository: string; commit: string; archive: string; destination: string; prepared: string; env: NodeJS.ProcessEnv }) {
  const packagePath = waffleSourceRoot(options.repository, options.commit);
  const [archive, extract, verify, prepare] = waffleSourcePlan(options.repository, options.commit, options.archive, options.destination, options.env, packagePath);
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
