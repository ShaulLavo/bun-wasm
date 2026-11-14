import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCacheKey, releaseDownload } from "./ci-release-download";

const url = "https://github.com/owner/project/releases/download/v1/input.tgz";
const api = "https://api.github.com/repos/owner/project/releases/tags/v1";
const asset = "https://api.github.com/repos/owner/project/releases/assets/42";
const metadata = () => Response.json({ assets: [{ name: "input.tgz", url: asset }] });

test.each([process.execPath, "node"])("%s retries a stalled body with a fresh deadline and publishes only complete bytes", async host => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-release-retry-"));
  let attempts = 0;
  let cancellations = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      attempts++;
      if (attempts === 3) return new Response("complete archive");
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
        cancel() { cancellations++; },
      }));
    },
  });
  try {
    const module = new URL("./ci-release-download.ts", import.meta.url).href;
    const script = `const { releaseDownload } = await import(${JSON.stringify(module)});
      const response = await releaseDownload(${JSON.stringify(url)}, {
        token: "fixture-token", cache: ${JSON.stringify(directory)}, attemptTimeoutMs: 150, timeoutMs: 3000,
        sleep: async () => {}, fetch: async (url, init) => url === ${JSON.stringify(api)}
          ? Response.json({ assets: [{ name: "input.tgz", url: ${JSON.stringify(asset)} }] })
          : fetch(${JSON.stringify(server.url.href)}, init),
      });
      console.log(await response.text());`;
    const child = Bun.spawn([host, "--input-type=module", "--eval", script], {
      signal: AbortSignal.timeout(4000), stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(stdout).toBe("complete archive\n");
    expect(attempts).toBe(3);
    expect(cancellations).toBe(2);
    expect(await readdir(directory)).toEqual([releaseCacheKey(url)]);
    expect(await readFile(join(directory, releaseCacheKey(url)), "utf8")).toBe("complete archive");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("three timed-out headers fail and remove staging instead of caching partial bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-release-timeout-"));
  let calls = 0;
  const download = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    calls++;
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  try {
    await expect(releaseDownload(url, { token: "fixture-token", cache: directory, fetch: download,
      attemptTimeoutMs: 20, sleep: async () => {},
    })).rejects.toThrow("request failed");
    expect(calls).toBe(3);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["caller", "overall"])("%s cancellation stops the current attempt without retrying", async kind => {
  const controller = new AbortController();
  let calls = 0;
  const download = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    calls++;
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await expect(releaseDownload(url, { token: "fixture-token", cache: undefined, fetch: download,
      signal: controller.signal, timeoutMs: kind === "overall" ? 15 : 3000,
    })).rejects.toThrow("request failed");
    expect(calls).toBe(1);
  } finally { clearTimeout(timer); }
});

test("metadata body failures retry, but invalid metadata fails immediately", async () => {
  let calls = 0;
  const download = async (input: string) => {
    if (input !== api) return new Response("complete archive");
    calls++;
    if (calls > 1) return metadata();
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("connection closed")); } }));
  };
  const response = await releaseDownload(url, { token: "fixture-token", cache: undefined, fetch: download, sleep: async () => {} });
  expect(await response.text()).toBe("complete archive");
  expect(calls).toBe(2);
  calls = 0;
  await expect(releaseDownload(url, { token: "fixture-token", cache: undefined,
    fetch: async () => { calls++; return Response.json({ assets: [] }); },
  })).rejects.toThrow("Missing GitHub release asset");
  expect(calls).toBe(1);
});

test.each([process.execPath, "node"])("%s removes uncached staging on consumption and cancellation", async host => {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-release-cleanup-"));
  try {
    const module = new URL("./ci-release-download.ts", import.meta.url).href;
    const script = `const { releaseDownload } = await import(${JSON.stringify(module)});
      const { readdir } = await import("node:fs/promises");
      const options = { token: "", cache: undefined, fetch: async () => new Response("archive") };
      await (await releaseDownload(${JSON.stringify(url)}, options)).text();
      await (await releaseDownload(${JSON.stringify(url)}, options)).body.cancel();
      console.log(JSON.stringify(await readdir(${JSON.stringify(directory)})));`;
    const child = Bun.spawn([host, "--input-type=module", "--eval", script], {
      env: { ...process.env, TMPDIR: directory, GITHUB_ACTIONS: "false" },
      signal: AbortSignal.timeout(4000), stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(stdout).toBe("[]\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
