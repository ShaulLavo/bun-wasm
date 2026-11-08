import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

type Options = {
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  cache?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
};

export const releaseCacheKey = (url: string): string => createHash("sha256").update(url).digest("hex");
const releasePattern = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/;
const retryable = new Set([408, 429, 500, 502, 503, 504]);

async function request(url: string, accept: string, options: Options): Promise<Response> {
  const download = options.fetch ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const target = new URL(url);
  const headers = new Headers({ Accept: accept });
  if (target.origin === "https://api.github.com" && options.token) headers.set("Authorization", `Bearer ${options.token}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try { response = await download(url, { headers, redirect: "manual", signal: options.signal }); }
    catch {
      if (options.signal?.aborted || attempt === 2) throw new Error("GitHub release request failed");
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!retryable.has(response.status) || attempt === 2) return response;
    await response.body?.cancel();
    await sleep(1000 * (attempt + 1));
  }
  throw new Error("Unreachable release retry state");
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
  if (!match || !options.token) return (options.fetch ?? fetch)(url, { signal: options.signal });
  const [, owner, repository, tag, name] = match;
  const metadata = await assetResponse(`https://api.github.com/repos/${owner}/${repository}/releases/tags/${tag}`, "application/vnd.github+json", options);
  if (!metadata.ok) throw new Error(`GitHub release metadata failed: HTTP ${metadata.status} ${url}`);
  const asset = findAsset(await metadata.json(), decodeURIComponent(name!));
  const response = await assetResponse(asset, "application/octet-stream", options);
  if (!response.ok) throw new Error(`GitHub release asset failed: HTTP ${response.status} ${url}`);
  return response;
}

export async function releaseDownload(url: string, options: Options = {}): Promise<Response> {
  const selected = {
    token: process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_TOKEN : undefined,
    cache: process.env.CI_RELEASE_CACHE,
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 180_000),
  };
  if (!releasePattern.test(url)) return (selected.fetch ?? fetch)(url, { signal: selected.signal });
  const path = selected.cache ? join(selected.cache, releaseCacheKey(url)) : undefined;
  if (path && await Bun.file(path).exists()) {
    console.log(`GitHub release cache hit: ${url}`);
    return new Response(Bun.file(path));
  }
  const response = await authenticatedRelease(url, selected);
  if (!response.ok || !path) return response;
  await mkdir(selected.cache!, { recursive: true });
  const stage = await mkdtemp(join(selected.cache!, ".download-"));
  try {
    await Bun.write(join(stage, "asset"), response);
    await rename(join(stage, "asset"), path);
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log(`GitHub release ${selected.token ? "authenticated API" : "public"} download: ${url}`);
  return new Response(Bun.file(path));
}

if (import.meta.main) {
  const [url, destination] = process.argv.slice(2);
  if (!url || !destination) throw new Error("Usage: ci-release-download.ts URL DESTINATION");
  const response = await releaseDownload(url);
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status} ${url}`);
  await Bun.write(destination, response);
}
