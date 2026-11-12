import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const maximumBytes = 603_979_776;
const maximumPages = 10;
const pageSize = 100;
const mainRef = "refs/heads/main";
type ObjectFact = { path: string; bytes: number };
type Snapshot = { version: 1; objects: ObjectFact[] };
type Inventory = { objects: ObjectFact[]; bytes: number };
type Cache = { id: number; key: string; ref: string; size: number; created: number };
type Namespace = { os: string; arch: string; job: string };
type Request = (url: string, init: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function isBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObjectPath(path: string): boolean {
  const match = /^([a-f0-9])\/([a-f0-9])\/([a-f0-9]{64})$/.exec(path);
  return match !== null && match[3]?.startsWith(`${match[1]}${match[2]}`) === true;
}

function parseSnapshot(value: unknown): Snapshot {
  const data = record(value);
  if (data.version !== 1 || !Array.isArray(data.objects)) throw new Error("Invalid compiler-object snapshot");
  const paths = new Set<string>();
  const objects = data.objects.map((value: unknown) => {
    const entry = record(value);
    if (typeof entry.path !== "string" || !isObjectPath(entry.path) || !isBytes(entry.bytes) || paths.has(entry.path)) {
      throw new Error("Invalid compiler-object snapshot entry");
    }
    paths.add(entry.path);
    return { path: entry.path, bytes: entry.bytes };
  });
  return { version: 1, objects };
}

async function inspectPath(directory: string, path: string, inventory: Inventory): Promise<void> {
  const target = path ? join(directory, path) : directory;
  const stat = await lstat(target);
  inventory.bytes += stat.size;
  if (!Number.isSafeInteger(inventory.bytes)) throw new Error("Compiler-object directory size overflow");
  if (stat.isFile() && isObjectPath(path)) inventory.objects.push({ path, bytes: stat.size });
  if (!stat.isDirectory()) return;
  for (const name of await readdir(target)) await inspectPath(directory, path ? `${path}/${name}` : name, inventory);
}

async function inventoryObjects(directory: string): Promise<Inventory> {
  const inventory: Inventory = { objects: [], bytes: 0 };
  try { await lstat(directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return inventory;
    throw error;
  }
  await inspectPath(directory, "", inventory);
  inventory.objects.sort((left, right) => left.path.localeCompare(right.path));
  return inventory;
}

export async function captureObjects(directory: string, snapshotPath: string): Promise<Snapshot> {
  const { objects } = await inventoryObjects(directory);
  const snapshot: Snapshot = { version: 1, objects };
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  return snapshot;
}

export async function planObjects(directory: string, snapshotPath: string) {
  const previous = parseSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
  const current = await inventoryObjects(directory);
  const original = new Map(previous.objects.map(object => [object.path, object.bytes]));
  const changed = current.objects.some(object => original.get(object.path) !== object.bytes);
  const hash = createHash("sha256");
  for (const object of current.objects) hash.update(`${object.path}\t${object.bytes}\n`);
  return { changed, fits: current.bytes <= maximumBytes, fingerprint: hash.digest("hex"), bytes: current.bytes };
}

function cacheNamespace(key: string): Namespace | null {
  const expression = /^rust-objects-v3-([A-Za-z0-9_]+)-([A-Za-z0-9_]+)-([A-Za-z0-9_][A-Za-z0-9_-]*)-[a-f0-9]{64}-[a-f0-9]{64}-[1-9][0-9]*-[1-9][0-9]*$/;
  const match = expression.exec(key);
  if (!match) return null;
  const [, os, arch, job] = match;
  if (!os || !arch || !job) return null;
  return { os, arch, job };
}

function sameNamespace(key: string, namespace: Namespace): boolean {
  const other = cacheNamespace(key);
  return other !== null && other.os === namespace.os && other.arch === namespace.arch && other.job === namespace.job;
}

function parseCache(value: unknown): Cache {
  const data = record(value);
  if (!isBytes(data.id) || data.id === 0 || typeof data.key !== "string" || typeof data.ref !== "string" || !isBytes(data.size_in_bytes)) {
    throw new Error("Invalid GitHub cache entry");
  }
  if (typeof data.created_at !== "string" || !Number.isFinite(Date.parse(data.created_at))) throw new Error("Invalid GitHub cache creation time");
  return { id: data.id, key: data.key, ref: data.ref, size: data.size_in_bytes, created: Date.parse(data.created_at) };
}

async function listCaches(url: string, request: Request, init: RequestInit): Promise<Cache[]> {
  const caches: Cache[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maximumPages; page++) {
    const response = await request(`${url}?ref=${encodeURIComponent(mainRef)}&key=rust-objects-&per_page=${pageSize}&page=${page}`, init);
    if (!response.ok) throw new Error(`GitHub cache listing failed (HTTP ${response.status})`);
    const data = record(await response.json());
    if (!isBytes(data.total_count) || data.total_count > maximumPages * pageSize || !Array.isArray(data.actions_caches)) throw new Error("Invalid or oversized GitHub cache listing");
    if (total !== undefined && total !== data.total_count) throw new Error("GitHub cache listing changed during pagination");
    total = data.total_count;
    const entries = data.actions_caches.map(parseCache);
    if (entries.length !== Math.min(pageSize, total - caches.length)) throw new Error("Incomplete GitHub cache listing");
    caches.push(...entries);
    if (caches.length === total) return caches;
  }
  throw new Error("GitHub cache listing exceeded the page limit");
}

function redundantCaches(caches: Cache[], publishedKey: string, namespace: Namespace): Cache[] {
  if (new Set(caches.map(cache => cache.id)).size !== caches.length) throw new Error("Duplicate GitHub cache IDs");
  const matching = caches.filter(cache => cache.ref === mainRef && cache.key.startsWith("rust-objects-v3-") && sameNamespace(cache.key, namespace));
  matching.sort((left, right) => right.created - left.created || right.id - left.id);
  const published = matching.find(cache => cache.key === publishedKey);
  if (!published) throw new Error("Published compiler-object snapshot is not visible");
  const other = matching.find(cache => cache.key !== publishedKey);
  return matching.filter(cache => cache.id !== published.id && cache.id !== other?.id);
}

export async function pruneObjects(
  publishedKey: string,
  environment: NodeJS.ProcessEnv = process.env,
  request: Request = fetch,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = message => console.warn(`::warning::${message}`),
): Promise<void> {
  if (environment.GITHUB_EVENT_NAME !== "push" || environment.GITHUB_REF !== mainRef) {
    warn("Compiler-object cache cleanup is restricted to main pushes");
    return;
  }
  try {
    await pruneMainObjects(publishedKey, environment, request, log);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown cleanup error";
    warn(`Compiler-object cache cleanup stopped; remaining snapshots are preserved: ${reason}`);
  }
}

async function pruneMainObjects(publishedKey: string, environment: NodeJS.ProcessEnv, request: Request, log: (message: string) => void): Promise<void> {
  const namespace = cacheNamespace(publishedKey);
  if (!namespace || !publishedKey.startsWith("rust-objects-v3-")) throw new Error("Expected a published v3 compiler-object key");
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GH_TOKEN;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error("Missing GitHub cache credentials");
  const url = `https://api.github.com/repos/${repository}/actions/caches`;
  const init: RequestInit = { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(30_000) };
  const caches = await listCaches(url, request, init);
  for (const cache of redundantCaches(caches, publishedKey, namespace)) {
    log(`Delete compiler-object snapshot id=${cache.id} key=${cache.key} size=${cache.size}`);
    const response = await request(`${url}/${cache.id}`, { ...init, method: "DELETE" });
    if (response.status !== 204) throw new Error(`GitHub cache deletion failed (HTTP ${response.status})`);
  }
}

async function main(): Promise<void> {
  const [command, directory, snapshotPath, extra] = process.argv.slice(2);
  if (command === "prune" && directory && !snapshotPath) return pruneObjects(directory);
  if (!directory || !snapshotPath || extra) throw new Error("Usage: ci-sccache-cache.ts capture|plan DIR SNAPSHOT | prune PUBLISHED_KEY");
  if (command === "capture") {
    await captureObjects(directory, snapshotPath);
    return;
  }
  if (command !== "plan") throw new Error("Expected capture, plan or prune");
  const plan = await planObjects(directory, snapshotPath);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required for the object archive plan");
  await appendFile(output, `changed=${plan.changed}\nfits=${plan.fits}\nfingerprint=${plan.fingerprint}\n`);
  console.log(`Compiler-object snapshot: changed=${plan.changed} fits=${plan.fits} bytes=${plan.bytes}`);
}

if (import.meta.main) await main();
