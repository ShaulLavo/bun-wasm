import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCacheLimits, retainReleaseCaches } from "./ci-release-cache";
import { releaseCacheKey } from "./ci-release-download";

const bunUrl = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip";
const nodeUrl = "https://github.com/actions/node-versions/releases/download/26.13.1-43134154182/node-26.13.1-linux-x64.tar.gz";

function brokenBody(): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("broken body")); } }));
}

test.each([process.execPath, "node"])("%s migrates warm bootstrap bytes, shares them across scopes, and isolates other releases", async host => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-bootstrap-pool-"));
  try {
    const module = new URL("./ci-release-download.ts", import.meta.url).href;
    const program = `const { releaseDownload, releaseCacheKey } = await import(${JSON.stringify(module)});
      const { mkdir, writeFile, readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const root = ${JSON.stringify(root)};
      const local = join(root, "local"); const shared = join(root, "shared");
      await mkdir(local); let calls = 0;
      const options = { cache: local, bootstrapCache: shared, token: "", fetch: async () => { calls++; return new Response("archive"); } };
      const urls = ${JSON.stringify([bunUrl, nodeUrl])};
      for (const url of urls) {
        await writeFile(join(local, releaseCacheKey(url)), "warm archive");
        if (await (await releaseDownload(url, options)).text() !== "warm archive") throw Error("migration changed bytes");
        if (await (await releaseDownload(url, { ...options, cache: join(root, "another-scope") })).text() !== "warm archive") throw Error("shared miss");
      }
      if (calls || (await readdir(local)).length) throw Error("migration downloaded or duplicated bytes");
      const newer = urls[0].replace("1.4.4", "1.4.5");
      await (await releaseDownload(newer, options)).text();
      const unrelated = urls[0].replace("oven-sh/bun", "owner/project");
      await (await releaseDownload(unrelated, options)).text();
      console.log(JSON.stringify({ calls, local: (await readdir(local)).sort(), shared: (await readdir(shared)).sort() }));`;
    const child = Bun.spawn([host, "--input-type=module", "--eval", program], {
      env: { ...process.env, GITHUB_ACTIONS: "false" }, signal: AbortSignal.timeout(4000), stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      calls: 2,
      local: [releaseCacheKey(bunUrl.replace("oven-sh/bun", "owner/project"))],
      shared: [bunUrl, nodeUrl, bunUrl.replace("1.4.4", "1.4.5")].map(releaseCacheKey).sort(),
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function sparse(directory: string, name: string, bytes: number, modified: number) {
  const path = join(directory, name.repeat(64));
  const file = await open(path, "w");
  try { await file.truncate(bytes); }
  finally { await file.close(); }
  await utimes(path, modified / 1000, modified / 1000);
}

test("retention bounds both pools, ages out unused files and partial staging, and removes duplicate local bootstrap copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-release-retain-"));
  const local = join(root, "local");
  const shared = join(root, "shared");
  const now = Date.now();
  try {
    await mkdir(local); await mkdir(shared);
    await sparse(shared, "a", releaseCacheLimits.bootstrap, now);
    await sparse(shared, "b", 1, now - 1000);
    await sparse(local, "a", 1, now);
    await sparse(local, "c", releaseCacheLimits.local, now);
    await sparse(local, "d", 1, now - 1000);
    await sparse(local, "e", 1, now - releaseCacheLimits.unusedMs - 1000);
    const partial = join(shared, ".download-interrupted");
    await mkdir(partial); await writeFile(join(partial, "asset"), "partial");
    expect(await retainReleaseCaches(local, shared, now)).toEqual({ bootstrapBytes: releaseCacheLimits.bootstrap, localBytes: releaseCacheLimits.local });
    expect(await readdir(shared)).toEqual(["a".repeat(64)]);
    expect(await readdir(local)).toEqual(["c".repeat(64)]);
    expect(await retainReleaseCaches(local, shared, now)).toEqual({ bootstrapBytes: releaseCacheLimits.bootstrap, localBytes: releaseCacheLimits.local });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retention rejects symlinks without touching their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-release-links-"));
  try {
    const local = join(root, "local"); const shared = join(root, "shared");
    await mkdir(local); await mkdir(shared);
    const outside = join(root, "outside");
    await writeFile(outside, "preserved");
    await symlink(outside, join(shared, "a".repeat(64)));
    await expect(retainReleaseCaches(local, shared)).rejects.toThrow("Unexpected release cache member");
    expect(await Bun.file(outside).text()).toBe("preserved");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unused local members expire, current reads refresh retention, and Bun-only jobs preserve Node archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-release-age-"));
  try {
    const local = join(root, "local"); const shared = join(root, "shared");
    await mkdir(local); await mkdir(shared);
    const now = Date.now();
    await sparse(local, "a", 1, now - releaseCacheLimits.unusedMs - 1000);
    await sparse(local, "b", 1, now - releaseCacheLimits.unusedMs + 1000);
    const inputUrl = bunUrl.replace("oven-sh/bun", "owner/project");
    const key = releaseCacheKey(inputUrl);
    const path = join(local, key);
    await writeFile(path, "archive");
    await utimes(path, 0, 0);
    const nodeKey = releaseCacheKey(nodeUrl);
    await writeFile(join(shared, nodeKey), "node");
    await utimes(join(shared, nodeKey), 0, 0);
    const { releaseDownload } = await import("./ci-release-download");
    expect(await (await releaseDownload(inputUrl, { cache: local, bootstrapCache: shared, token: "",
      fetch: async () => { throw new Error("Unexpected download"); },
    })).text()).toBe("archive");
    expect(await retainReleaseCaches(local, shared, now)).toEqual({ localBytes: 8, bootstrapBytes: 4 });
    expect((await readdir(local)).sort()).toEqual(["b".repeat(64), key].sort());
    expect(await readdir(shared)).toEqual([nodeKey]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cold shared bootstrap retries publish only complete bytes and clear their staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-bootstrap-retry-"));
  try {
    const local = join(root, "local"); const shared = join(root, "shared");
    await mkdir(local);
    const { releaseDownload } = await import("./ci-release-download");
    let attempts = 0;
    const response = await releaseDownload(bunUrl, { cache: local, bootstrapCache: shared, token: "fixture-token", sleep: async () => {},
      fetch: async input => {
        if (input.includes("/releases/tags/")) return Response.json({ assets: [{ name: "bun-linux-x64.zip", url: "https://api.github.com/repos/oven-sh/bun/releases/assets/42" }] });
        attempts++;
        if (attempts === 2) return new Response("complete");
        return brokenBody();
      },
    });
    expect(await response.text()).toBe("complete");
    expect(attempts).toBe(2);
    expect(await readdir(shared)).toEqual([releaseCacheKey(bunUrl)]);
    expect(await readdir(local)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bootstrap keys are stable across source edits and restore before setup without replacing existing warm scope fallbacks", async () => {
  const restore = await Bun.file(new URL("../.github/actions/release-downloads/action.yml", import.meta.url)).text();
  const save = await Bun.file(new URL("../.github/actions/save-release-downloads/action.yml", import.meta.url)).text();
  expect(restore).toContain('CI_BOOTSTRAP_CACHE_KEY=release-bootstrap-v1-${{ runner.os }}-${{ runner.arch }}"');
  expect(restore).toContain("restore-keys: ${{ env.CI_BOOTSTRAP_CACHE_KEY }}-");
  expect(restore).toContain("release-assets-v2-${{ runner.os }}-${{ runner.arch }}-${{ inputs.scope }}-");
  expect(save).not.toContain("github.sha");
  expect(save).not.toContain("github.run_id");
  expect(save).toContain("steps.bootstrap-inventory.outputs.changed == 'true'");
});
