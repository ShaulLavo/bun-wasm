import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCacheKey, releaseDownload } from "./ci-release-download";

const url = "https://github.com/owner/project/releases/download/v1/input.tgz";
const api = "https://api.github.com/repos/owner/project/releases/tags/v1";
const asset = "https://api.github.com/repos/owner/project/releases/assets/42";
const signed = "https://release-assets.githubusercontent.com/input?signature=temporary";
const metadata = () => Response.json({ assets: [{ name: "input.tgz", url: asset }] });

test("release API requests authenticate, but the signed redirect receives no credentials", async () => {
  const requests: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];
  const download = async (input: string, init?: RequestInit) => {
    requests.push({ url: input, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (input === api) return metadata();
    if (input === asset) return new Response(null, { status: 302, headers: { location: signed } });
    return new Response("archive");
  };
  const result = await releaseDownload(url, { token: "fixture-token", fetch: download });
  expect(await result.text()).toBe("archive");
  expect(requests).toEqual([
    { url: api, auth: "Bearer fixture-token", redirect: "manual" },
    { url: asset, auth: "Bearer fixture-token", redirect: "manual" },
    { url: signed, auth: null, redirect: "manual" },
  ]);
});

test("cache identity uses the entire original URL, never the signed redirect or token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-release-cache-"));
  try {
    let calls = 0;
    const download = async (input: string) => { calls++; return input === api ? metadata() : new Response("archive"); };
    const options = { token: "fixture-token", cache: directory, fetch: download };
    expect(await (await releaseDownload(url, options)).text()).toBe("archive");
    expect(await (await releaseDownload(url, { ...options, token: "another-token" })).text()).toBe("archive");
    expect(calls).toBe(2);
    expect(releaseCacheKey(url)).not.toBe(releaseCacheKey(url.replace("v1/", "v2/")));
    expect(releaseCacheKey(url)).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("transient failures retry three times with bounded backoff and preserve the final error", async () => {
  const waits: number[] = [];
  let calls = 0;
  await expect(releaseDownload(url, {
    token: "fixture-token",
    fetch: async () => { calls++; return new Response(null, { status: 504 }); },
    sleep: async delay => { waits.push(delay); },
  })).rejects.toThrow("504");
  expect(calls).toBe(3);
  expect(waits).toEqual([1000, 2000]);
});

test("permanent failures and unrelated redirects fail without retries or credential forwarding", async () => {
  let calls = 0;
  await expect(releaseDownload(url, { token: "fixture-token", fetch: async () => {
    calls++; return new Response(null, { status: 404 });
  } })).rejects.toThrow("404");
  expect(calls).toBe(1);
  await expect(releaseDownload(url, { token: "fixture-token", fetch: async () => new Response(null, {
    status: 302, headers: { location: "https://unrelated.example/input" },
  }) })).rejects.toThrow("redirect");
});

test("non-release downloads and local non-CI use do not receive the job token", async () => {
  let authorization: string | null = "not-called";
  const download = async (_input: string, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization"); return new Response("source");
  };
  await releaseDownload("https://raw.githubusercontent.com/owner/project/commit/input", { token: "fixture-token", fetch: download });
  expect(authorization).toBeNull();
  expect(await (await releaseDownload(url, { fetch: download, token: "" })).text()).toBe("source");
  expect(authorization).toBeNull();
});

test("CI callers use the downloader and consume a completed cache rather than racing setup", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  for (const name of ["package", "web", "process-bundles"]) expect(workflow).toContain(`  ${name}:\n    needs: quality`);
  expect(workflow).toContain("Publish the completed dependency cache before consumer jobs");
  expect(workflow).toContain("key: ${{ steps.bun-dependencies.outputs.cache-primary-key }}");
  expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
  const native = await Bun.file(new URL("./waffle-release-inputs.ts", import.meta.url)).text();
  expect(native.match(/download: Download = releaseDownload/g)).toHaveLength(2);
  const sccache = await Bun.file(new URL("../.github/actions/rust-build-cache/action.yml", import.meta.url)).text();
  expect(sccache).toContain('scripts/ci-release-download.ts" "$url"');
  expect(sccache).toContain("sha256sum --check");
  expect(sccache).not.toContain("mozilla-actions/sccache-action@");
});

test("connection failures stay bounded and redirect loops cannot run indefinitely", async () => {
  let calls = 0;
  await expect(releaseDownload(url, { token: "fixture-token", fetch: async () => {
    calls++; throw new Error("fixture connection closed");
  }, sleep: async () => {} })).rejects.toThrow("request failed");
  expect(calls).toBe(3);
  calls = 0;
  await expect(releaseDownload(url, { token: "fixture-token", fetch: async input => {
    calls++; return new Response(null, { status: 302, headers: { location: input } });
  } })).rejects.toThrow("redirect");
  expect(calls).toBe(4);
});
