import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, access } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Options = {
  token?: string;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  signal?: AbortSignal;
  cache?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
};

export const releaseCacheKey = (url: string): string => createHash("sha256").update(url).digest("hex");
const releasePattern = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/;
const retryable = new Set([408, 429, 500, 502, 503, 504]);
class RetryableDownloadError extends Error {}

async function request(url: string, accept: string, options: Options): Promise<Response> {
  const download = options.fetch ?? fetch;
  const target = new URL(url);
  const headers = new Headers({ Accept: accept });
  if (target.origin === "https://api.github.com" && options.token) headers.set("Authorization", `Bearer ${options.token}`);
  try { return await download(url, { headers, redirect: "manual", signal: options.signal }); }
  catch { throw new RetryableDownloadError("GitHub release request failed"); }
}

function redirectTarget(location: string, from: string): string {
  const target = new URL(location, from);
  if (target.protocol !== "https:" || target.username || target.password || ![
    "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
  ].includes(target.hostname)) throw new Error("Unsupported GitHub release redirect");
  return target.href;
}

async function assetResponse(url: string, accept: string, options: Options): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await request(url, accept, options);
    if (retryable.has(response.status)) {
      await response.body?.cancel();
      throw new RetryableDownloadError(`GitHub release request failed: HTTP ${response.status}`);
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 3) throw new Error("Invalid GitHub release redirect");
    url = redirectTarget(location, url);
  }
  throw new Error("Unreachable release redirect state");
}

function findAsset(value: unknown, name: string): string {
  if (!value || typeof value !== "object" || !("assets" in value) || !Array.isArray(value.assets))
    throw new Error("Invalid GitHub release metadata");
  const asset: unknown = value.assets.find((entry: unknown) => entry && typeof entry === "object" && "name" in entry && entry.name === name);
  if (!asset || typeof asset !== "object" || !("url" in asset) || typeof asset.url !== "string"
    || !/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/\d+$/.test(asset.url))
    throw new Error(`Missing GitHub release asset: ${name}`);
  return asset.url;
}

async function authenticatedRelease(url: string, options: Options): Promise<Response> {
  const match = releasePattern.exec(url);
  if (!match || !options.token) {
    let response: Response;
    try { response = await (options.fetch ?? fetch)(url, { signal: options.signal }); }
    catch { throw new RetryableDownloadError("GitHub release request failed"); }
    if (!retryable.has(response.status)) return response;
    await response.body?.cancel();
    throw new RetryableDownloadError(`GitHub release request failed: HTTP ${response.status}`);
  }
  const [, owner, repository, tag, name] = match;
  const metadata = await assetResponse(`https://api.github.com/repos/${owner}/${repository}/releases/tags/${tag}`, "application/vnd.github+json", options);
  if (!metadata.ok) throw new Error(`GitHub release metadata failed: HTTP ${metadata.status} ${url}`);
  const asset = findAsset(await metadata.json(), decodeURIComponent(name!));
  const response = await assetResponse(asset, "application/octet-stream", options);
  if (!response.ok) throw new Error(`GitHub release asset failed: HTTP ${response.status} ${url}`);
  return response;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function fileResponse(path: string, cleanup?: () => Promise<void>, init?: ResponseInit): Response {
  const input = createReadStream(path);
  const chunks = input[Symbol.asyncIterator]();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await chunks.next();
        if (chunk.done) await cleanup?.();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) { await cleanup?.(); controller.error(error); }
    },
    async cancel() { input.destroy(); await cleanup?.(); },
  }), init);
}

export async function saveReleaseResponse(path: string, response: Response, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw new Error("Release download has no body");
  await pipeline(response.body, createWriteStream(path), { signal });
}

async function downloadToStage(url: string, path: string, options: Options): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    const deadline = new AbortController();
    const timer = globalThis.setTimeout(() => deadline.abort(new Error("GitHub release attempt timed out")), options.attemptTimeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    try {
      const response = await authenticatedRelease(url, { ...options, signal });
      if (response.ok) await saveReleaseResponse(path, response, signal);
      return response;
    } catch (error) {
      if (options.signal?.aborted || attempt === 2) throw error;
      if (!deadline.signal.aborted && !(error instanceof RetryableDownloadError) && !(error instanceof TypeError)) throw error;
    } finally { globalThis.clearTimeout(timer); }
    await rm(path, { force: true });
    if (options.sleep) await options.sleep(1000 * (attempt + 1));
    else await setTimeout(1000 * (attempt + 1), undefined, { signal: options.signal });
  }
  throw new Error("Unreachable release retry state");
}

export async function releaseDownload(url: string, options: Options = {}): Promise<Response> {
  const selected = {
    token: process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_TOKEN : undefined,
    cache: process.env.CI_RELEASE_CACHE,
    ...options,
    signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 180_000)].concat(options.signal ? [options.signal] : [])),
  };
  if (!releasePattern.test(url)) return (selected.fetch ?? fetch)(url, { signal: selected.signal });
  const path = selected.cache ? join(selected.cache, releaseCacheKey(url)) : undefined;
  if (path && await exists(path)) {
    console.error(`GitHub release cache hit: ${url}`);
    return fileResponse(path);
  }
  if (process.env.GITHUB_ACTIONS === "true" && !selected.token) throw new Error("CI release downloads require GITHUB_TOKEN");
  if (selected.cache) await mkdir(selected.cache, { recursive: true });
  const stage = await mkdtemp(join(selected.cache ?? tmpdir(), selected.cache ? ".download-" : "bun-wasm-release-"));
  const staged = join(stage, "asset");
  const cleanup = () => rm(stage, { recursive: true, force: true });
  try {
    const response = await downloadToStage(url, staged, selected);
    if (!response.ok) { await cleanup(); return response; }
    if (!path) return fileResponse(staged, cleanup, response);
    await rename(staged, path);
  } catch (error) { await cleanup(); throw error; }
  await cleanup();
  console.error(`GitHub release ${selected.token ? "authenticated API" : "public"} download: ${url}`);
  return fileResponse(path);
}

if (import.meta.main) {
  const [url, destination, timeout] = process.argv.slice(2);
  if (!url || !destination) throw new Error("Usage: ci-release-download.ts URL DESTINATION");
  const response = await releaseDownload(url, timeout ? { timeoutMs: Number(timeout) } : {});
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status} ${url}`);
  await saveReleaseResponse(destination, response);
}
