import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { updateReleaseLock } from "./ci-update-lock";
import { installStagedPackages } from "./ci-install";
import { stageReleasePackages, verifyStagedResolutions } from "./ci-stage-release-packages";
import { selectNodeRelease } from "./ci-bootstrap-tools";

const releaseUrl = (name: string) => `https://github.com/owner/project/releases/download/v1/${name.replaceAll("/", "-")}.tgz`;
const digest = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function packageArchive(root: string, name: string, dependencies: Record<string, string>, prefix = "package") {
  const source = join(root, name);
  await mkdir(join(source, prefix), { recursive: true });
  await writeFile(join(source, prefix, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }));
  const archive = join(source, "input.tgz");
  expect(Bun.spawnSync(["tar", "-czf", archive, "-C", source, prefix]).exitCode).toBe(0);
  return readFile(archive);
}

async function releaseFixture(scratch: string) {
  const inputs = new Map([
    [releaseUrl("@waffle/python"), await packageArchive(scratch, "@waffle/python", {})],
    [releaseUrl("child"), await packageArchive(scratch, "child", { "@waffle/python": releaseUrl("@waffle/python") })],
    [releaseUrl("example"), await packageArchive(scratch, "example", { child: releaseUrl("child") })],
  ]);
  const dependencies = { example: releaseUrl("example") };
  const manifest = JSON.stringify({ name: "consumer", dependencies });
  const packages = Object.fromEntries(Array.from(inputs, ([url, bytes]) => {
    const name = url === releaseUrl("example") ? "example" : url === releaseUrl("child") ? "child" : "@waffle/python";
    const dependencies = name === "example" ? { child: releaseUrl("child") } : name === "child" ? { "@waffle/python": releaseUrl("@waffle/python") } : {};
    return [name, [`${name}@${url}`, { dependencies }, digest(bytes)]];
  }));
  const lock = JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces: { "": { name: "consumer", dependencies } }, packages });
  const download = async (url: string) => {
    const bytes = inputs.get(url);
    if (!bytes) throw new Error(`Unexpected download: ${url}`);
    return new Response(bytes);
  };
  return { manifest, lock, download };
}

test("a staged release closure installs frozen with an empty cache and all network access disabled", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-release-offline-"));
  try {
    const fixture = await releaseFixture(scratch);
    const source = join(scratch, "source");
    const consumer = join(scratch, "consumer");
    await mkdir(source);
    await mkdir(consumer);
    await writeFile(join(source, "package.json"), fixture.manifest);
    await writeFile(join(source, "bun.lock"), fixture.lock);
    const locations = await stageReleasePackages(source, consumer, fixture.download);
    const staged = await readFile(join(consumer, "bun.lock"), "utf8");
    expect(staged.includes("https://github.com")).toBe(false);
    verifyStagedResolutions(fixture.lock, staged, locations);
    const cache = join(scratch, "empty-cache");
    await mkdir(cache);
    expect(await readdir(cache)).toEqual([]);
    const installed = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--offline"], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache } });
    if (installed.exitCode) console.error(installed.stderr.toString());
    expect(installed.exitCode).toBe(0);
    const example = createRequire(join(consumer, "package.json")).resolve("example/package.json");
    const child = createRequire(example).resolve("child/package.json");
    const python = createRequire(child).resolve("@waffle/python/package.json");
    expect(JSON.parse(await readFile(python, "utf8")).version).toBe("1.0.0");
    expect(await readFile(join(source, "package.json"), "utf8")).toBe(fixture.manifest);
    expect(await readFile(join(source, "bun.lock"), "utf8")).toBe(fixture.lock);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("ordinary CI installs restore product manifests and locks on success and failure", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-ci-installs-"));
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  try {
    const fixture = await releaseFixture(scratch);
    for (const name of ["root", "web", "sandbox", "site"]) {
      const source = join(scratch, name);
      await mkdir(source);
      await writeFile(join(source, "package.json"), fixture.manifest);
      await writeFile(join(source, "bun.lock"), fixture.lock);
      process.env.BUN_INSTALL_CACHE_DIR = join(source, "empty-cache");
      await installStagedPackages(source, ["--frozen-lockfile", "--offline", "--ignore-scripts"], fixture.download);
      await expect(installStagedPackages(source, ["--frozen-lockfile", "--offline"], async () => new Response("wrong bytes"))).rejects.toThrow("integrity");
      expect(await readFile(join(source, "package.json"), "utf8")).toBe(fixture.manifest);
      expect(await readFile(join(source, "bun.lock"), "utf8")).toBe(fixture.lock);
    }
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Node bootstrap preserves major and exact version selectors", () => {
  const entry = (version: string, stable = true) => ({ version, stable, files: [{ platform: "linux", arch: "x64", download_url: `https://github.com/actions/node-versions/releases/download/${version}-1/node-${version}-linux-x64.tar.gz` }] });
  const manifest = [entry("26.9.0"), entry("26.13.0"), entry("26.14.0", false), entry("27.0.0")];
  expect(selectNodeRelease(manifest, "26").version).toBe("26.13.0");
  expect(selectNodeRelease(manifest, "26.9.0").version).toBe("26.9.0");
  expect(() => selectNodeRelease(manifest, "25")).toThrow("Missing Node release");
});

test("CI bootstraps tools, ICU and every install through the authenticated adapters", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  expect(workflow.includes("oven-sh/setup-bun@")).toBe(false);
  expect(workflow.includes("actions/setup-node@")).toBe(false);
  expect(workflow.includes("bun install ")).toBe(false);
  const helper = await Bun.file(new URL("./test-web-host.sh", import.meta.url)).text();
  expect(helper).not.toMatch(/\bbun install\b/);
  expect(helper.match(/scripts\/ci-install\.ts/g)).toHaveLength(3);
  const updater = await Bun.file(new URL("../.github/workflows/owned-dependency-update.yml", import.meta.url)).text();
  expect(updater).toContain("GITHUB_TOKEN: ${{ github.token }}");
  expect(updater.includes("setup-node@")).toBe(false);
  expect(await Bun.file(new URL("../.github/scripts/update-owned-dependencies.sh", import.meta.url)).text()).toContain("bun scripts/ci-update-lock.ts web");
  expect(await Bun.file(new URL("../jsc/build-icu.sh", import.meta.url)).text()).toContain("scripts/ci-release-download.ts");
});


test("updating new URL pins resolves their release transitives offline and restores original archive integrity", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-update-offline-"));
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  try {
    const fixture = await releaseFixture(scratch);
    const source = join(scratch, "source");
    await mkdir(source);
    await writeFile(join(source, "package.json"), fixture.manifest);
    await writeFile(join(source, "bun.lock"), JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces: { "": { name: "consumer" } }, packages: {} }));
    process.env.BUN_INSTALL_CACHE_DIR = join(scratch, "empty-cache");
    await updateReleaseLock(source, fixture.download, true);
    const canonical = await readFile(join(source, "bun.lock"), "utf8");
    expect(canonical.includes(scratch)).toBe(false);
    expect(await readFile(join(source, "package.json"), "utf8")).toBe(fixture.manifest);
    await installStagedPackages(source, ["--frozen-lockfile", "--offline"], fixture.download);
    expect(await readFile(join(source, "bun.lock"), "utf8")).toBe(canonical);
    await expect(updateReleaseLock(source, async () => new Response("wrong bytes"), true)).rejects.toThrow("integrity mismatch");
    expect(await readFile(join(source, "bun.lock"), "utf8")).toBe(canonical);
    expect(await readFile(join(source, "package.json"), "utf8")).toBe(fixture.manifest);
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});

function actionSteps(source: string): Record<string, unknown>[] {
  const value: unknown = Bun.YAML.parse(source);
  if (!value || typeof value !== "object" || !("runs" in value) || !value.runs || typeof value.runs !== "object" || !("steps" in value.runs) || !Array.isArray(value.runs.steps)) throw new Error("Invalid composite action");
  return value.runs.steps.map((step: unknown) => {
    if (!step || typeof step !== "object") throw new Error("Invalid composite action step");
    return Object.fromEntries(Object.entries(step));
  });
}

test("release caches can grow after partial restore without saving duplicate warm inventories", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-cache-inventory-"));
  try {
    const cache = join(scratch, "assets");
    const environment = join(scratch, "environment");
    const output = join(scratch, "output");
    const restore = await Bun.file(new URL("../.github/actions/release-downloads/action.yml", import.meta.url)).text();
    const save = await Bun.file(new URL("../.github/actions/save-release-downloads/action.yml", import.meta.url)).text();
    const initialScript = actionSteps(restore)[2]?.run;
    const saveScript = actionSteps(save)[0]?.run;
    if (typeof initialScript !== "string" || typeof saveScript !== "string") throw new Error("Missing cache inventory script");
    const env = { ...process.env, CI_RELEASE_CACHE: cache, GITHUB_ENV: environment, GITHUB_OUTPUT: output };
    expect(Bun.spawnSync(["bash", "-euo", "pipefail", "-c", initialScript], { env }).exitCode).toBe(0);
    const initial = (await readFile(environment, "utf8")).trim().split("=")[1]!;
    const run = async (fingerprint: string) => {
      await writeFile(output, "");
      expect(Bun.spawnSync(["bash", "-euo", "pipefail", "-c", saveScript], { env: { ...env, CI_RELEASE_CACHE_INITIAL: fingerprint } }).exitCode).toBe(0);
      return readFile(output, "utf8");
    };
    expect(await run(initial)).not.toContain("changed=true");
    await writeFile(join(cache, "new-url-hash"), "verified archive");
    const grown = await run(initial);
    expect(grown).toContain("changed=true");
    expect(await run(grown.split("\n")[0]!.split("=")[1]!)).not.toContain("changed=true");
    expect(save).toContain("if: steps.inventory.outputs.changed == 'true'");
    expect(save).not.toContain("github.run_id");
    const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    expect(workflow.match(/uses: \.\/\.github\/actions\/save-release-downloads/g)?.length).toBe(workflow.match(/uses: \.\/\.github\/actions\/release-downloads/g)?.length);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});


test("new Git pins resolve scoped release transitives offline and preserve canonical Git archive identity", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-update-git-offline-"));
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  try {
    const fixture = await releaseFixture(scratch);
    const revision = "1234567890123456789012345678901234567890";
    const git = `git+https://github.com/owner/project.git#${revision}`;
    const archiveId = "owner-project-1234567";
    const bytes = await packageArchive(scratch, "git-parent", { example: releaseUrl("example") }, archiveId);
    const source = join(scratch, "source");
    await mkdir(source);
    const manifest = JSON.stringify({ name: "consumer", dependencies: { "git-parent": git } });
    await writeFile(join(source, "package.json"), manifest);
    await writeFile(join(source, "bun.lock"), JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces: { "": { name: "consumer" } }, packages: {} }));
    process.env.BUN_INSTALL_CACHE_DIR = join(scratch, "empty-cache");
    const download = async (url: string) => {
      if (url === `https://raw.githubusercontent.com/owner/project/${revision}/package.json`) return Response.json({ name: "git-parent", version: "1.0.0", dependencies: { example: releaseUrl("example") } });
      if (url === `https://codeload.github.com/owner/project/legacy.tar.gz/${revision}`) return new Response(bytes);
      return fixture.download(url);
    };
    await updateReleaseLock(source, download, true);
    const canonical = await readFile(join(source, "bun.lock"), "utf8");
    expect(canonical.includes(scratch)).toBe(false);
    const python = await fixture.download(releaseUrl("@waffle/python"));
    expect(Bun.JSONC.parse(canonical)).toMatchObject({
      workspaces: { "": { dependencies: { "git-parent": git } } },
      packages: {
        "git-parent": ["git-parent@github:owner/project#1234567", { dependencies: { example: releaseUrl("example") } }, archiveId, digest(bytes)],
        "@waffle/python": [`@waffle/python@${releaseUrl("@waffle/python")}`, {}, digest(await python.bytes())],
      },
    });
    expect(await readFile(join(source, "package.json"), "utf8")).toBe(manifest);
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});
