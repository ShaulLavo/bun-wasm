// Fingerprints are embedded in the HTML so cache lookup does not add a network round trip.
export function assetBuild(name: string): string | null {
  if (!("__bunwasmBuilds" in globalThis)) return null;
  const builds: unknown = Reflect.get(globalThis, "__bunwasmBuilds");
  if (!builds || typeof builds !== "object" || !(name in builds)) return null;
  const value: unknown = Reflect.get(builds, name);
  return typeof value === "string" ? value : null;
}

/** The hashed chunks a first command loads (web/build.ts), relative to the page. */
export function commandChunks(): string[] {
  const chunks: unknown = Reflect.get(globalThis, "__bunwasmCommandChunks");
  if (!Array.isArray(chunks)) return [];
  return chunks.filter((chunk): chunk is string => typeof chunk === "string" && /^chunks\/[\w-]+\.js$/.test(chunk));
}

const CACHE = "bunwasm-engines";
const MARKER = "bunwasm-engine-cache:";

/**
 * Which build this origin last stored for `url`, read synchronously. A first visit then skips
 * CacheStorage, whose first use can take seconds in Firefox, and downloads at once. Undefined
 * where the page has no usable localStorage (workers, blocked storage): those keep the lookup.
 */
function storedBuild(url: string): string | null | undefined {
  try {
    const storage: Storage | undefined = globalThis.localStorage;
    return storage ? storage.getItem(MARKER + url) : undefined;
  } catch {
    return undefined;
  }
}

/** Records `build` for `url`, or nothing: a marker that cannot be updated is removed. */
function mark(url: string, build: string | null): void {
  try {
    if (build === null) globalThis.localStorage?.removeItem(MARKER + url);
    else globalThis.localStorage?.setItem(MARKER + url, build);
  } catch {
    unmark(url);
  }
}

function unmark(url: string): void {
  try {
    globalThis.localStorage?.removeItem(MARKER + url);
  } catch {
    // Unusable storage reads as unmarked, which keeps the CacheStorage lookup.
  }
}

/**
 * The cached bytes of `build`. Unless `always`, an absent or different marker answers "none"
 * without opening CacheStorage. Loaders pass `always` once the network has failed, so bytes a
 * lost marker hides still serve.
 */
export async function cachedEngine(url: string, build: string, always = false): Promise<Response | null> {
  const stored = always ? undefined : storedBuild(url);
  if (stored !== undefined && stored !== build) return null;
  try {
    const response = await caches.match(url, { cacheName: CACHE });
    return response?.headers.get("x-bunwasm-build") === build ? response : null;
  } catch {
    return null;
  }
}

export async function cacheEngine(url: string, build: string, response: Response): Promise<boolean> {
  try {
    const headers = new Headers(response.headers);
    headers.set("x-bunwasm-build", build);
    await (await caches.open(CACHE)).put(url, new Response(response.body, { headers }));
    mark(url, build);
    return true;
  } catch {
    // Disabled or full storage must not stop a working engine.
    return false;
  }
}

export async function evictEngine(url: string): Promise<void> {
  mark(url, null);
  try {
    await (await caches.open(CACHE)).delete(url);
  } catch {
    // A fresh network load can still run when cache cleanup is unavailable.
  }
}
