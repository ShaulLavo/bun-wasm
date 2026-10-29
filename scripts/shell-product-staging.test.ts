import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import release from "./waffle-release-inputs.json";
import { browserBuildConfig, resolveRuntimePackage } from "./browser-build";
import { pinnedBashWeb, verifiedGuests } from "./bash-web-guests";
import { PreparationFlow } from "../tests/shell-product/prepare-flow";
import { stageWaffle, waffleCommits, waffleSourceRoot } from "../tests/shell-product/waffle-stage";

const shellCommit = "a".repeat(40);
const gitPeer = (commit: string) => `git+https://github.com/ShaulLavo/waffle.git#${commit}`;

test("the ordinary Shell producer, public product selection and both apps pin the same Bash source", async () => {
  const root = resolve(import.meta.dir, "..");
  const producer = await readFile(join(root, "scripts/build-bash-web-shell.sh"), "utf8");
  const commit = pinnedBashWeb(join(root, "web"));
  expect(/^commit=([a-f0-9]{40})$/m.exec(producer)?.[1]).toBe(commit);
  expect(pinnedBashWeb(join(root, "sandbox"))).toBe(commit);
  expect(waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: commit }, release.url).shellCommit).toBe(commit);
});

test("an explicit Bash source is preserved when its revision differs from the pin", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bw-provided-shell-"));
  const source = join(scratch, "provided");
  const bin = join(scratch, "bin");
  try {
    await mkdir(source);
    await mkdir(bin);
    await Bun.write(join(source, "owner-work"), "keep");
    await Bun.write(join(bin, "git"), '#!/bin/sh\nif [ "$3" = rev-parse ]; then printf other-revision; exit 0; fi\nexit 42\n');
    await chmod(join(bin, "git"), 0o755);
    const result = Bun.spawnSync(["bash", join(import.meta.dir, "build-bash-web-shell.sh")], { env: {
      ...process.env, BASH_WEB_SOURCE: source, CARGO_TARGET_DIR: join(scratch, "target"), PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(join(source, "owner-work")).text()).toBe("keep");
    expect(result.stderr.toString()).toContain("Provided bash-web source does not match");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("Shell receipt validation rejects stale, partial and changed unit guest fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-shell-receipt-unit-"));
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const commit = "a".repeat(40);
  try {
    expect(verifiedGuests(root, commit)).toBeUndefined();
    await Bun.write(join(root, "bash-web-shell.wasm"), bytes);
    await Bun.write(join(root, "bash-web-env.wasm"), bytes);
    expect(() => verifiedGuests(root, commit)).toThrow("no bash-web-guests.json");
    const write = Bun.spawnSync([process.execPath, join(import.meta.dir, "bash-web-guests.ts"), "write", root, commit, "unit-fixture-toolchain"]);
    expect(write.exitCode).toBe(0);
    expect(verifiedGuests(root, commit)?.map(guest => guest.program)).toEqual(["shell-engine.wasm", "env.wasm"]);
    expect(() => verifiedGuests(root, "b".repeat(40))).toThrow("but the consumer pins");
    await Bun.write(join(root, "bash-web-shell.wasm"), new Uint8Array([1]));
    expect(() => verifiedGuests(root, commit)).toThrow("does not match bash-web-guests.json");
    await Bun.write(join(root, "bash-web-shell.wasm"), bytes);
    await rm(join(root, "bash-web-env.wasm"));
    expect(() => verifiedGuests(root, commit)).toThrow("does not match bash-web-guests.json");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the checked archive peer retains source identity without requiring a Git install pin", () => {
  const selected = waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: shellCommit }, release.url);
  expect(selected).toEqual({ shellCommit, wafflePeer: release.url, wafflePeerCommit: release.sourceCommit, waffleHostCommit: release.sourceCommit });
  expect(waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: shellCommit, SHELL_PRODUCT_WAFFLE_COMMIT: release.sourceCommit }, release.url)).toEqual(selected);
  expect(() => waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: shellCommit, SHELL_PRODUCT_WAFFLE_COMMIT: "b".repeat(40) }, release.url)).toThrow("must match");
  for (const peer of ["waffle", "^0.0.91", release.url + "#ignored", release.url.replace("github.com", "example.com"), gitPeer("main"), "file:../waffle"])
    expect(() => waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: shellCommit }, peer)).toThrow("Waffle peer");
});

function git(repository: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repository].concat(args), { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function sourceFixture(root: string, child: boolean) {
  const repository = join(root, child ? "monorepo # source" : "historical # source");
  const packageRoot = child ? join(repository, "packages/waffle") : repository;
  await mkdir(join(packageRoot, "tooling"), { recursive: true });
  await Bun.write(join(repository, "package.json"), JSON.stringify({ name: "waffle-monorepo", private: true, workspaces: ["packages/*"] }));
  await Bun.write(join(packageRoot, "package.json"), JSON.stringify({ name: "waffle", version: release.version, private: child }));
  await Bun.write(join(packageRoot, "scripts/build-wasi-libc.sh"), "selected child builder");
  await Bun.write(join(packageRoot, "patches/wasi-libc/preopen-scan.patch"), "selected child patch");
  await Bun.write(join(packageRoot, "prepare.ts"), 'await Bun.write("prepared.txt", "canonical package root");');
  await Bun.write(join(packageRoot, "tooling/build-network.ts"), 'if (process.env.WAFFLE_NETWORK_PREBUILT !== "1" || !await Bun.file("browser/net/network.wasm").exists()) throw new Error("Unverified network");');
  git(repository, "init", "--quiet");
  git(repository, "add", ".");
  git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  return { repository, packageRoot, commit: git(repository, "rev-parse", "HEAD") };
}

async function checkSourceVariant(root: string, child: boolean, prepared: string, flow: PreparationFlow) {
  const f = await sourceFixture(root, child);
  expect(waffleSourceRoot(f.repository, f.commit)).toBe(child ? "packages/waffle" : "");
  if (child) expect(() => waffleSourceRoot(f.repository, f.commit, true)).toThrow("not an installable Waffle peer");
  else expect(waffleSourceRoot(f.repository, f.commit, true)).toBe("");
  await Bun.write(join(f.packageRoot, "package.json"), JSON.stringify({ name: "uncommitted-wrong-package" }));
  const destination = join(root, child ? "child # installed" : "old # installed");
  await stageWaffle(flow, { repository: f.repository, commit: f.commit, archive: join(root, "source # archive.tar"), destination, prepared, env: process.env });
  expect(await readFile(join(destination, "prepared.txt"), "utf8")).toBe("canonical package root");
  expect(await Bun.file(join(destination, "packages/waffle/package.json")).exists()).toBe(false);
  expect(await Bun.file(join(destination, "package.json")).json()).toEqual({ name: "waffle", version: release.version, private: child });
  expect(await readFile(join(destination, "scripts/build-wasi-libc.sh"), "utf8")).toBe("selected child builder");
  expect(await readFile(join(destination, "patches/wasi-libc/preopen-scan.patch"), "utf8")).toBe("selected child patch");
  await Bun.write(join(f.packageRoot, "package.json"), JSON.stringify({ name: "wrong-package" }));
  git(f.repository, "add", ".");
  git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "invalid package");
  expect(() => waffleSourceRoot(f.repository, git(f.repository, "rev-parse", "HEAD"))).toThrow();
  expect(() => waffleSourceRoot(f.repository, "f".repeat(40))).toThrow("Missing Waffle source manifest");
  expect(waffleSourceRoot(f.repository, f.commit)).toBe(child ? "packages/waffle" : "");
}

test("real Git staging selects public historical roots and private monorepo children at the exact commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-sp-source-"));
  const flow = new PreparationFlow();
  try {
    const prepared = join(root, "borrowed # package");
    for (const name of ["network.wasm", "network.sha256", "network.input-hash"])
      await Bun.write(join(prepared, "browser/net", name), `borrowed ${name}`);
    for (const child of [false, true]) {
      await checkSourceVariant(root, child, prepared, flow);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a public monorepo root cannot impersonate the historical package root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-sp-workspace-"));
  try {
    const f = await sourceFixture(root, true);
    await Bun.write(join(f.repository, "package.json"), JSON.stringify({ name: "waffle", version: release.version, private: false, workspaces: ["packages/*"] }));
    git(f.repository, "add", ".");
    git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "public workspace root");
    const commit = git(f.repository, "rev-parse", "HEAD");
    expect(waffleSourceRoot(f.repository, commit)).toBe("packages/waffle");
    expect(() => waffleSourceRoot(f.repository, commit, true)).toThrow("not an installable Waffle peer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a child workspace named waffle is not a source package", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-sp-child-workspace-"));
  try {
    const f = await sourceFixture(root, true);
    await Bun.write(join(f.packageRoot, "package.json"), JSON.stringify({ name: "waffle", workspaces: ["packages/*"] }));
    git(f.repository, "add", ".");
    git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "child workspace");
    const commit = git(f.repository, "rev-parse", "HEAD");
    expect(() => waffleSourceRoot(f.repository, commit)).toThrow("Invalid Waffle source package");
    expect(() => waffleSourceRoot(f.repository, commit, true)).toThrow("not an installable Waffle peer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a private repository root is not an installable peer or a child source package", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-sp-private-root-"));
  try {
    const f = await sourceFixture(root, false);
    await Bun.write(join(f.packageRoot, "package.json"), JSON.stringify({ name: "waffle", private: true }));
    git(f.repository, "add", ".");
    git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "private root");
    const commit = git(f.repository, "rev-parse", "HEAD");
    expect(() => waffleSourceRoot(f.repository, commit)).toThrow("Missing Waffle source manifest");
    expect(() => waffleSourceRoot(f.repository, commit, true)).toThrow("not an installable Waffle peer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function checkInstalledRelease(root: string) {
  const modules = join(root, "node_modules");
  await mkdir(modules);
  await symlink(resolve(import.meta.dir, "../node_modules/waffle"), join(modules, "waffle"), "dir");
  const entries = [join(root, "main.ts"), join(root, "worker.ts")];
  for (const [index, entry] of entries.entries())
    await Bun.write(entry, `import { createRuntime } from "waffle"; import { createWorkerProcessTransport } from "waffle/proc/worker-client"; import { loadNetworkModule } from "waffle/network"; globalThis.realm${index} = { createRuntime, createWorkerProcessTransport, loadNetworkModule };`);
  const main = entries[0];
  if (!main) throw new Error("Missing main fixture");
  const runtime = resolveRuntimePackage(main);
  expect(runtime.metadata.version).toBe(release.version);
  expect(Object.keys(runtime.metadata.exports)).toHaveLength(73);
  for (const key of Object.keys(runtime.metadata.exports)) {
    const specifier = key === "." ? "waffle" : "waffle" + key.slice(1);
    expect(await Bun.file(runtime.source(specifier)).exists()).toBe(true);
  }
  for (const member of ["browser/net/network.wasm", "browser/net/network.sha256", "browser/net/network.input-hash", "LICENSE", "LICENSES/Apache-2.0.txt"])
    expect(await Bun.file(join(runtime.path, member)).exists()).toBe(true);
  const output = join(root, "bundled");
  const result = await Bun.build(browserBuildConfig(entries, output));
  expect(result.success).toBe(true);
  if (!result.metafile) throw new Error("Missing bundle inputs");
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.filter(input => runtime.relativeInput(input) === "proc/worker-client.ts")).toHaveLength(1);
  const loaders = result.outputs.filter(file => file.path.endsWith(".js"));
  const networkAssets = new Set<string>();
  for (const file of loaders) {
    if ((await file.text()).includes("./network.wasm")) networkAssets.add(join(dirname(file.path), "network.wasm"));
  }
  expect(networkAssets.size).toBeGreaterThan(0);
  for (const path of networkAssets)
    expect(await Bun.file(path).bytes()).toEqual(await Bun.file(join(runtime.path, "browser/net/network.wasm")).bytes());
}

test("installed release exports, network assets and shared worker imports resolve to one physical package", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-sp-exports-"));
  try {
    await checkInstalledRelease(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
