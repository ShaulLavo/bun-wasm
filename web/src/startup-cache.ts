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

export async function cachedEngine(url: string, build: string): Promise<Response | null> {
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
    return true;
  } catch {
    // Disabled or full storage must not stop a working engine.
    return false;
  }
}

export async function evictEngine(url: string): Promise<void> {
  try {
    await (await caches.open(CACHE)).delete(url);
  } catch {
    // A fresh network load can still run when cache cleanup is unavailable.
  }
}
