import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { object } from "../goals-matrix/evidence";
import { livePlaygroundPath } from "../goals-matrix/iphone-live-proxy";

/** A generous hang cap for one download from the deployed site, not a speed limit. */
const liveFetchTimeoutMs = 120_000;
export type LiveFetch = (url: string) => Promise<Response>;
export const liveFetch: LiveFetch = url => fetch(url, { signal: AbortSignal.timeout(liveFetchTimeoutMs), redirect: "follow" });
export type LiveSource = { commit: string; dirty: null; assets: { source: string; deployment: Record<string, unknown> } };

/** The deployed site's own record of what it serves. */
export async function liveSource(site: string, get: LiveFetch): Promise<LiveSource> {
  const response = await get(new URL("deployment.json", site).href);
  if (!response.ok) throw new Error(`Live site deployment.json answered ${response.status}`);
  const deployment = object(await response.json());
  const { sourceCommit, waffleVersion } = deployment;
  if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Live site deployment.json has no 40-character sourceCommit");
  const recorded: Record<string, unknown> = { sourceCommit };
  if (typeof waffleVersion === "string") recorded.waffleVersion = waffleVersion;
  return { commit: sourceCommit, dirty: null, assets: { source: site, deployment: recorded } };
}

async function download(get: LiveFetch, url: string, path: string, required: boolean): Promise<boolean> {
  const response = await get(url);
  if (response.status === 404 && !required) { await response.body?.cancel(); return false; }
  if (!response.ok) throw new Error(`Live site ${url} answered ${response.status}`);
  await Bun.write(path, new Uint8Array(await response.arrayBuffer()));
  return true;
}

/**
 * Copies the deployed playground's host page, manifest and the named engine files into a scratch
 * root shaped like a local build, runs `check` on it, then removes it. A deployed `.gz` copy
 * stands in for its plain file, as in a local build.
 */
export async function withLiveRoot<T>(site: string, names: readonly string[], get: LiveFetch, check: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-iphone-smoke-live-"));
  try {
    const playground = new URL(livePlaygroundPath, site);
    await download(get, playground.href, join(root, "index.html"), true);
    await download(get, new URL("engine-builds.json", playground).href, join(root, "engine-builds.json"), true);
    for (const name of names) await downloadEngine(get, playground, root, name);
    return await check(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function downloadEngine(get: LiveFetch, playground: URL, root: string, name: string): Promise<void> {
  const path = join(root, name);
  if (await download(get, new URL(name + ".gz", playground).href, path + ".gz", false)) return;
  if (!await download(get, new URL(name, playground).href, path, false)) throw new Error(`Live site is missing ${name}`);
}
