import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { object } from "../goals-matrix/evidence";
import { StepFailure } from "./model";
import { comparedHeaders, decodedSha256, livePlaygroundPath, pick, type LiveServed } from "../goals-matrix/iphone-live-proxy";

/** A generous hang cap for one download from the deployed site, not a speed limit. */
const liveFetchTimeoutMs = 120_000;
/** Bun's fetch options; `decompress: false` keeps the origin's encoded bytes. */
export type LiveFetch = (url: string, init?: RequestInit & { decompress?: boolean }) => Promise<Response>;
export const liveFetch: LiveFetch = (url, init = {}) => fetch(url, { redirect: "follow", ...init, signal: AbortSignal.timeout(liveFetchTimeoutMs) });
export type LiveSource = { commit: string; dirty: null; assets: { source: string; deployment: Record<string, unknown> } };
export type LiveOriginCheck = { checked: number; mismatches: string[] };

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

/** The deployed playground must be cross-origin isolated by its own headers; the observer never adds them in live mode. */
function requireIsolation(headers: Headers): void {
  const opener = headers.get("cross-origin-opener-policy"), embedder = headers.get("cross-origin-embedder-policy");
  if (opener !== "same-origin" || (embedder !== "require-corp" && embedder !== "credentialless")) throw new StepFailure("isolation",`Live isolation check: the deployed playground is not cross-origin isolated (COOP ${String(opener)}, COEP ${String(embedder)})`);
}

async function download(get: LiveFetch, url: string, path: string, required: boolean): Promise<Response | undefined> {
  const response = await get(url);
  if (response.status === 404 && !required) { await response.body?.cancel(); return; }
  if (!response.ok) throw new Error(`Live site ${url} answered ${response.status}`);
  await Bun.write(path, new Uint8Array(await response.arrayBuffer()));
  return response;
}

/**
 * Copies the deployed playground's host page, manifest and the named engine files into a scratch
 * root shaped like a local build, runs `check` on it, then removes it. A deployed `.gz` copy
 * stands in for its plain file, as in a local build. The host page must carry isolation headers.
 */
export async function withLiveRoot<T>(site: string, names: readonly string[], get: LiveFetch, check: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-iphone-smoke-live-"));
  try {
    const playground = new URL(livePlaygroundPath, site);
    const page = await download(get, playground.href, join(root, "index.html"), true);
    requireIsolation(page!.headers);
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

function servedRows(value: unknown): LiveServed[] {
  if (!Array.isArray(value)) throw new Error("Live origin check: the observer returned no served-response list");
  return value.map(item => {
    const row = object(item);
    if (typeof row.url !== "string" || !row.url.startsWith("/") || typeof row.status !== "number" || (row.sha256 !== null && typeof row.sha256 !== "string")) throw new Error("Live origin check: malformed served response");
    return { url: row.url, status: row.status, sha256: row.sha256, request: strings(row.request), headers: strings(row.headers) };
  });
}
function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * Repeats every request the proxy made, with the same request headers, against the real origin
 * from the PC, and compares status, the compared headers and the decoded bytes.
 */
export async function compareLiveOrigin(site: string, served: unknown, get: LiveFetch): Promise<LiveOriginCheck> {
  const rows = servedRows(served);
  const page = "/" + livePlaygroundPath;
  const mismatches: string[] = [];
  if (!rows.some(row => row.url === page || row.url.startsWith(page + "?"))) mismatches.push(`the run served no ${page} page`);
  for (const row of rows) mismatches.push(...await compareRow(site, row, get));
  return { checked: rows.length, mismatches };
}
async function compareRow(site: string, row: LiveServed, get: LiveFetch): Promise<string[]> {
  const response = await get(new URL(row.url, site).href, { headers: row.request, redirect: "manual", decompress: false });
  const bytes = await response.bytes();
  const headers = pick(response.headers, comparedHeaders);
  const found: string[] = [];
  if (response.status !== row.status) found.push(`${row.url}: status ${row.status} in the run, ${response.status} from the real origin`);
  for (const name of comparedHeaders) {
    if (headers[name] !== row.headers[name]) found.push(`${row.url}: ${name} ${JSON.stringify(row.headers[name] ?? null)} in the run, ${JSON.stringify(headers[name] ?? null)} from the real origin`);
  }
  if (row.sha256 === null) return found.concat(`${row.url}: the run could not decode its bytes`);
  if (decodedSha256(bytes, response.headers.get("content-encoding")) !== row.sha256) found.push(`${row.url}: decoded bytes differ from the real origin`);
  return found;
}
