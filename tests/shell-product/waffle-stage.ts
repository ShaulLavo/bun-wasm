import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import release from "../../scripts/waffle-release-inputs.json";
import { assertExactHostInterface, packageHostInterface, parseHostInterface, prepareWaffleReleaseArchive } from "../../scripts/waffle-release-inputs";
import { resolveRuntimePackage } from "../../scripts/browser-build";
import { restorePackedBun } from "./prepare-flow";
import type { PreparationFlow } from "./prepare-flow";

export const networkFiles = ["network.wasm", "network.sha256", "network.input-hash"] as const;
export const waffleSelectionFile = ".shell-product-host.json";
export type WaffleCommits = { wafflePeer: string; shellCommit: string; wafflePeerCommit: string; waffleHostCommit: string };
export type WaffleSelection = WaffleCommits & { hostInterface: ReturnType<typeof parseHostInterface>; networkInputHash: string };

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
    hostInterface: parseHostInterface(value.hostInterface, "Retained Waffle selection"),
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
  const selectedPeer = wafflePeer((peer === "*" ? release.url : peer) ?? (requested ? `git+https://github.com/ShaulLavo/waffle.git#${requested}` : release.url));
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
  if (isRecord(root) && root.name === "waffle" && root.private !== true && root.workspaces === undefined) {
    assertSelectedHostInterface(root, `${commit}:package.json`);
    return "";
  }
  assert.ok(!gitPeer, "A monorepo Git root is not an installable Waffle peer; use the published release archive");
  const child = gitMetadata(repository, `${commit}:packages/waffle/package.json`);
  assert.ok(isRecord(child) && child.name === "waffle" && child.workspaces === undefined, "Invalid Waffle source package");
  assertSelectedHostInterface(child, `${commit}:packages/waffle/package.json`);
  return "packages/waffle";
}

function assertSelectedHostInterface(metadata: unknown, source: string) {
  const provided = packageHostInterface(metadata, source);
  assertExactHostInterface(parseHostInterface(release.hostInterface, "Waffle release inputs"), provided, source);
  return provided;
}

export function assertWafflePeer(peer: unknown, selected: string, source: string): void {
  assert.ok(peer === "*" || peer === selected, `${source}: Waffle peer must be wildcard placement metadata or the exact selected runtime`);
}

function lockPackageDirectory(installation: string, key: string): string {
  const parts = key.split("/");
  const names: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    let name = parts[index];
    assert.ok(name && name !== "." && name !== ".." && /^@?[a-zA-Z0-9_.-]+$/.test(name), "Invalid installed lock package path");
    if (name.startsWith("@")) {
      const member = parts[++index];
      assert.ok(member && member !== "." && member !== ".." && /^[a-zA-Z0-9_.-]+$/.test(member), "Invalid installed scoped package path");
      name += "/" + member;
    }
    names.push(name);
  }
  return join(installation, "node_modules", names.join("/node_modules/"));
}

function installedWaffleEntries(lock: unknown, specifier: string): [string, string][] {
  assert.ok(isRecord(lock) && isRecord(lock.packages), "Invalid installed Bun lock packages");
  assert.ok(isRecord(lock.workspaces) && isRecord(lock.workspaces[""]) && isRecord(lock.workspaces[""].dependencies), "Missing installed runtime selection");
  assert.equal(lock.workspaces[""].dependencies.waffle, specifier, "Installed runtime must retain its exact selected edge");
  const runtime = lock.packages.waffle;
  assert.ok(Array.isArray(runtime) && typeof runtime[0] === "string", "Missing runtime lock entry");
  const git = /^waffle@github:ShaulLavo\/waffle#([a-f0-9]{7,40})$/.exec(runtime[0]);
  const exactGit = specifier.startsWith("git+") && git?.[1] && specifier.slice(-40).startsWith(git[1]);
  assert.ok(runtime[0] === `waffle@${specifier}` || exactGit, "Runtime lock identity must match its exact selected edge");
  const selected: [string, string][] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    assert.ok(Array.isArray(entry) && typeof entry[0] === "string", `Invalid installed lock entry ${key}`);
    const name = /^(waffle(?:-[a-z0-9-]+)?|@waffle\/[a-z0-9-]+)@/.exec(entry[0])?.[1];
    if (name) selected.push([key, name]);
    else assert.ok(!/(?:^|\/)waffle$/.test(key), "Invalid runtime lock identity");
  }
  assert.deepEqual(selected.filter(([, name]) => name === "waffle").map(([key]) => key), ["waffle"], "One runtime lock entry");
  return selected;
}

async function assertInstalledPackage(directory: string, name: string, selected: string, runtime: string, provided: ReturnType<typeof parseHostInterface>) {
  const metadata: unknown = await Bun.file(join(directory, "package.json")).json();
  assertExactHostInterface(packageHostInterface(metadata, name), provided, name);
  assert.ok(isRecord(metadata) && metadata.name === name, `Installed ${name} identity`);
  assertWafflePeer(isRecord(metadata.peerDependencies) ? metadata.peerDependencies.waffle : undefined, selected, name);
  assert.ok(!isRecord(metadata.dependencies) || metadata.dependencies.waffle === undefined, `${name}: published runtime dependency is not placement metadata`);
  assert.equal(await realpath(join(resolveRuntimePackage(join(directory, "src/index.ts")).path, "package.json")), runtime, "One physical runtime peer");
}

export async function assertInstalledWaffle(installation: string, selected: string) {
  wafflePeer(selected);
  const runtime = join(installation, "node_modules/waffle/package.json");
  const metadata: unknown = await Bun.file(runtime).json();
  const provided = assertSelectedHostInterface(metadata, "Installed Waffle");
  assert.ok(isRecord(metadata) && metadata.name === "waffle", "Installed Waffle identity");
  if (selected === release.url) assert.equal(metadata.version, release.version, "Selected Waffle release version");
  const packages = installedWaffleEntries(Bun.JSONC.parse(await readFile(join(installation, "bun.lock"), "utf8")), selected);
  const physical = await realpath(runtime);
  for (const [key, name] of packages.concat([["bash-web", "bash-web"], ["bun-wasm", "bun-wasm"]])) {
    if (name === "waffle") continue;
    await assertInstalledPackage(lockPackageDirectory(installation, key), name, selected, physical, provided);
  }
  return provided;
}

export async function stageReleasedWaffle(flow: PreparationFlow, options: { peer: string; archive: string; destination: string }) {
  flow.check();
  await prepareWaffleReleaseArchive(options.peer, options.archive);
  flow.check();
  await restorePackedBun(flow, options);
  const metadata: unknown = await Bun.file(join(options.destination, "package.json")).json();
  assert.ok(isRecord(metadata) && metadata.name === "waffle" && metadata.version === release.version, "Invalid released Waffle package");
  assertSelectedHostInterface(metadata, options.destination);
}
export async function writeWaffleSelection(installation: string, commits: WaffleCommits) {
  const value = selection({ ...commits, hostInterface: await assertInstalledWaffle(installation, commits.wafflePeer), networkInputHash: await installedNetworkHash(installation) });
  await writeFile(join(installation, waffleSelectionFile), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
export async function readWaffleSelection(installation: string, commits: WaffleCommits) {
  const expected = selection({ ...commits, hostInterface: await assertInstalledWaffle(installation, commits.wafflePeer), networkInputHash: await installedNetworkHash(installation) });
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
