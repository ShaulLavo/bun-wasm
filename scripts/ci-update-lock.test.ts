import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateReleaseLock } from "./ci-update-lock";

const revision = "1234567890123456789012345678901234567890";
const git = `git+https://github.com/owner/project.git#${revision}`;
const gitUrl = `https://codeload.github.com/owner/project/legacy.tar.gz/${revision}`;
const archiveId = "owner-project-1234567";
const otherGit = `git+https://github.com/owner/other.git#${revision}`;
const otherGitUrl = `https://codeload.github.com/owner/other/legacy.tar.gz/${revision}`;
const releaseUrl = "https://github.com/owner/project/releases/download/v1/released.tgz";
const integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function packageEntries(text: string): Record<string, unknown> {
  const lock: unknown = Bun.JSONC.parse(text);
  assert.ok(lock && typeof lock === "object" && "packages" in lock);
  assert.ok(lock.packages && typeof lock.packages === "object");
  return Object.fromEntries(Object.entries(lock.packages));
}

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
  const rangedIntegrity = integrity(ranged);
  const inputs = new Map([
    [gitUrl, await archive(root, "git-parent", archiveId)],
    [otherGitUrl, await archive(root, "other-git", "owner-other-1234567")],
    [releaseUrl, await archive(root, "released")],
  ]);
  const requests: string[] = [];
  let notifyInstall = () => {};
  const installing = new Promise<void>(resolve => { notifyInstall = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request): Response | Promise<Response> {
      const url = new URL(request.url);
      const bytes = inputs.get(url.searchParams.get("source") ?? "");
      if (bytes) return new Response(bytes);
      const path = url.pathname;
      requests.push(path);
      if (path === "/waiting") {
        notifyInstall();
        return new Promise(resolve => request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })), { once: true }));
      }
      if (path.endsWith(".tgz")) return new Response(ranged);
      const version = (value: string) => ({ name: "ranged", version: value, dist: { tarball: `${server.url}ranged-${value}.tgz`, integrity: integrity(ranged) } });
      return Response.json({ name: "ranged", "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": version("1.0.0"), "1.1.0": version("1.1.0") } });
    },
  });
  const source = join(root, "consumer");
  try {
    await mkdir(source);
    const dependencies = { "git-parent": git, "other-git": otherGit, released: releaseUrl, ranged: "^1.0.0" };
    const manifest = JSON.stringify({ name: "consumer", dependencies });
    const packages = {
      "git-parent": ["git-parent@github:owner/project#1234567", {}, archiveId, integrity(inputs.get(gitUrl)!)],
      "other-git": ["other-git@github:owner/other#1234567", {}, "owner-other-1234567", integrity(inputs.get(otherGitUrl)!)],
      released: [`released@${releaseUrl}`, {}, integrity(inputs.get(releaseUrl)!)],
      ranged: ["ranged@1.0.0", `${server.url}ranged-1.0.0.tgz`, {}, rangedIntegrity],
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
    return { source, manifest, lock, download, requests, server, installing, rangedIntegrity };
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
    expect(Bun.JSONC.parse(updated)).toEqual(Bun.JSONC.parse(f.lock));
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

test("a rejected lock cannot publish fresh unrelated resolutions and restores both inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-update-rejected-"));
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const f = await fixture(root);
    server = f.server;
    process.env.BUN_INSTALL_CACHE_DIR = join(root, "cache");
    const lock = f.lock.replace(f.rangedIntegrity, "invalid-integrity");
    await writeFile(join(f.source, "bun.lock"), lock);
    await expect(updateReleaseLock(f.source, f.download)).rejects.toThrow("unrelated package: ranged");
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).toBe(lock);
    expect(await readFile(join(f.source, "package.json"), "utf8")).toBe(f.manifest);
  } finally {
    server?.stop(true);
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a requested Git revision replaces its old lock entry without refreshing unrelated ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-update-git-revision-"));
  const previous = process.env.BUN_INSTALL_CACHE_DIR;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const f = await fixture(root);
    server = f.server;
    process.env.BUN_INSTALL_CACHE_DIR = join(root, "cache");
    const next = "abcdef0123456789012345678901234567890123";
    const nextArchive = "owner-project-abcdef0";
    const bytes = await archive(root, "git-parent", nextArchive);
    const manifest = f.manifest.replace(revision, next);
    await writeFile(join(f.source, "package.json"), manifest);
    await updateReleaseLock(f.source, url => url === gitUrl.replace(revision, next) ? Promise.resolve(new Response(bytes)) : f.download(url));
    const text = await readFile(join(f.source, "bun.lock"), "utf8");
    const updated = packageEntries(text);
    const original = packageEntries(f.lock);
    expect(updated["git-parent"]).toEqual(["git-parent@github:owner/project#abcdef0", {}, nextArchive, integrity(bytes)]);
    expect(updated.ranged).toEqual(original.ranged);
    expect(updated["other-git"]).toEqual(original["other-git"]);
    expect(updated.released).toEqual(original.released);
    expect(text).toContain(git.replace(revision, next));
    expect(f.requests).toEqual([]);
    expect(await readFile(join(f.source, "package.json"), "utf8")).toBe(manifest);
    const published = await readFile(join(f.source, "bun.lock"), "utf8");
    const download = (url: string) => url === gitUrl.replace(revision, next) ? Promise.resolve(new Response(bytes)) : f.download(url);
    await updateReleaseLock(f.source, download);
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).toBe(published);
    const invalid = f.lock.replace(f.rangedIntegrity, "invalid-integrity");
    await writeFile(join(f.source, "bun.lock"), invalid);
    await expect(updateReleaseLock(f.source, download)).rejects.toThrow("unrelated package: ranged");
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).toBe(invalid);
    expect(await readFile(join(f.source, "package.json"), "utf8")).toBe(manifest);
    const other = original["other-git"];
    assert.ok(Array.isArray(other) && typeof other[3] === "string");
    const changedOther = f.lock.replace(other[3], `sha512-${"A".repeat(86)}==`);
    await writeFile(join(f.source, "bun.lock"), changedOther);
    await expect(updateReleaseLock(f.source, download)).rejects.toThrow("unrelated package: other-git");
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).toBe(changedOther);
    expect(await readFile(join(f.source, "package.json"), "utf8")).toBe(manifest);
  } finally {
    server?.stop(true);
    if (previous === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
    else process.env.BUN_INSTALL_CACHE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a real installer restores the manifest and lock and removes resolver scratch", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-update-cancel-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const f = await fixture(root);
    server = f.server;
    const manifest = JSON.stringify({ ...JSON.parse(f.manifest), dependencies: { ...JSON.parse(f.manifest).dependencies, waiting: "1.0.0" } });
    await writeFile(join(f.source, "package.json"), manifest);
    const temporary = join(root, "temporary");
    await mkdir(temporary);
    const code = `import { updateReleaseLock } from ${JSON.stringify(join(import.meta.dir, "ci-update-lock.ts"))};
      await updateReleaseLock(process.argv[1], (url, options) => fetch(process.argv[2] + '?source=' + encodeURIComponent(url), { signal: options?.signal }));`;
    child = Bun.spawn([process.execPath, "-e", code, f.source, String(f.server.url)], {
      env: { ...process.env, TMPDIR: temporary, BUN_INSTALL_CACHE_DIR: join(root, "cache") },
      stdout: "pipe", stderr: "pipe",
    });
    await Promise.race([
      f.installing,
      child.exited.then(code => { throw new Error(`Updater exited before installer wait: ${code}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Installer did not reach registry")), 10_000); }),
    ]);
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).not.toBe(f.lock);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    expect(await readFile(join(f.source, "package.json"), "utf8")).toBe(manifest);
    expect(await readFile(join(f.source, "bun.lock"), "utf8")).toBe(f.lock);
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    clearTimeout(timer);
    child?.kill();
    if (child) await child.exited;
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
