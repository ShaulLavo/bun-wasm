import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageReleasePackages } from "./ci-stage-release-packages";

const url = "https://github.com/owner/project/releases/download/v1/example.tgz";

test("a staged direct release installs frozen with an empty cache and the network disabled", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-release-offline-"));
  try {
    const source = join(scratch, "source");
    const consumer = join(scratch, "consumer");
    await mkdir(join(source, "package"), { recursive: true });
    await mkdir(consumer);
    await writeFile(join(source, "package/package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
    const archive = join(scratch, "example.tgz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", source, "package"]).exitCode).toBe(0);
    const bytes = await readFile(archive);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "consumer", dependencies: { example: url } }));
    await writeFile(join(source, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "consumer", dependencies: { example: url } } }, packages: { example: [`example@${url}`, {}, integrity] } }));
    await stageReleasePackages(source, consumer, async () => new Response(bytes));
    const env = { ...process.env, BUN_INSTALL_CACHE_DIR: join(scratch, "resolution-cache") };
    const resolved = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts", "--offline"], { cwd: consumer, env });
    if (resolved.exitCode) console.error(resolved.stderr.toString());
    expect(resolved.stderr.toString()).not.toContain("cache miss");
    expect(resolved.exitCode).toBe(0);
    const installed = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--offline"], { cwd: consumer, env: { ...env, BUN_INSTALL_CACHE_DIR: join(scratch, "empty-cache") } });
    expect(installed.stderr.toString()).not.toContain("cache miss");
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(consumer, "node_modules/example/package.json"), "utf8")).version).toBe("1.0.0");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("CI bootstraps tool actions and ICU without public release download clients", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  expect(workflow.includes("oven-sh/setup-bun@")).toBe(false);
  expect(workflow.includes("actions/setup-node@")).toBe(false);
  expect(await Bun.file(new URL("../jsc/build-icu.sh", import.meta.url)).text()).toContain("scripts/ci-release-download.ts");
});
