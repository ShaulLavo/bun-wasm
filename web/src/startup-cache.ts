// Fingerprints are embedded in the HTML so cache lookup does not add a network round trip.
export function assetBuild(name: string): string | null {
  if (!("__bunwasmBuilds" in globalThis)) return null;
  const builds: unknown = Reflect.get(globalThis, "__bunwasmBuilds");
  if (!builds || typeof builds !== "object" || !(name in builds)) return null;
  const value: unknown = Reflect.get(builds, name);
  return typeof value === "string" ? value : null;
}

const CACHE = "bunwasm-engines";

export async function cachedEngine(url: string, build: string): Promise<Response | null> {
  try {
    if (localStorage.getItem(`${CACHE}:${url}`) !== build) return null;
    const response = await (await caches.open(CACHE)).match(url);
    return response?.headers.get("x-bunwasm-build") === build ? response : null;
  } catch {
    return null;
  }
}

export async function cacheEngine(url: string, build: string, response: Response): Promise<void> {
  try {
    const headers = new Headers(response.headers);
    headers.set("x-bunwasm-build", build);
    await (await caches.open(CACHE)).put(url, new Response(response.body, { headers }));
    localStorage.setItem(`${CACHE}:${url}`, build);
  } catch {
    // Disabled or full storage must not stop a working engine.
  }
}

export async function evictEngine(url: string): Promise<void> {
  try {
    localStorage.removeItem(`${CACHE}:${url}`);
    await (await caches.open(CACHE)).delete(url);
  } catch {
    // A fresh network load can still run when cache cleanup is unavailable.
  }
}
