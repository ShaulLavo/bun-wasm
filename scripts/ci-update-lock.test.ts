import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateReleaseLock } from "./ci-update-lock";

const revision = "1234567890123456789012345678901234567890";
const git = `git+https://github.com/owner/project.git#${revision}`;
const gitUrl = `https://codeload.github.com/owner/project/legacy.tar.gz/${revision}`;
const archiveId = "owner-project-1234567";
const releaseUrl = "https://github.com/owner/project/releases/download/v1/released.tgz";
const integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function archive(root: string, name: string, prefix = "package") {
  const source = join(root, name);
  await mkdir(join(source, prefix), { recursive: true });
  await writeFile(join(source, prefix, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  const path = join(source, "input.tgz");
  expect(Bun.spawnSync(["tar", "-czf", path, "-C", source, prefix]).exitCode).toBe(0);
  return readFile(path);
}

async function fixture(root: string) {
  const ranged = await archive(root, "ranged");
  const inputs = new Map([
    [gitUrl, await archive(root, "git-parent", archiveId)],
    [releaseUrl, await archive(root, "released")],
  ]);
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path.endsWith(".tgz")) return new Response(ranged);
      const version = (value: string) => ({ name: "ranged", version: value, dist: { tarball: `${server.url}ranged-${value}.tgz`, integrity: integrity(ranged) } });
      return Response.json({ name: "ranged", "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": version("1.0.0"), "1.1.0": version("1.1.0") } });
    },
  });
  const source = join(root, "consumer");
  try {
    await mkdir(source);
    const dependencies = { "git-parent": git, released: releaseUrl, ranged: "^1.0.0" };
    const manifest = JSON.stringify({ name: "consumer", dependencies });
    const packages = {
      "git-parent": ["git-parent@github:owner/project#1234567", {}, archiveId, integrity(inputs.get(gitUrl)!)],
      released: [`released@${releaseUrl}`, {}, integrity(inputs.get(releaseUrl)!)],
      ranged: ["ranged@1.0.0", "", {}, integrity(ranged)],
    };
    const lock = JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces: { "": { name: "consumer", dependencies } }, packages });
    await writeFile(join(source, "package.json"), manifest);
    await writeFile(join(source, "bun.lock"), lock);
    await writeFile(join(source, "bunfig.toml"), `[install]\nregistry = "${server.url}"\n`);
    const download = async (url: string) => {
      const bytes = inputs.get(url);
      if (!bytes) throw new Error(`Unexpected source download: ${url}`);
      return new Response(bytes);
    };
    return { source, manifest, lock, packages, download, requests, server };
  } catch (error) { server.stop(true); throw error; }
}

test("existing Git and release pins update through real Bun without refreshing unrelated ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-update-existing-"));
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const f = await fixture(root);
    server = f.server;
    process.env.BUN_INSTALL_CACHE_DIR = join(root, "cache");
    await updateReleaseLock(f.source, f.download);
    const updated = await readFile(join(f.source, "bun.lock"), "utf8");
    expect(Bun.JSONC.parse(updated).packages).toEqual(f.packages);
    expect(updated).not.toContain(root);
    expect(f.requests).toEqual([]);
    expect(await readFile(join(f.source, "package.json"), "utf8")).toBe(f.manifest);
    await updateReleaseLock(f.source, f.download);
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).toBe(updated);
  } finally {
    server?.stop(true);
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
