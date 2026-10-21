import { packageFetch } from "./package-fetch.js";

const METADATA = "application/vnd.npm.install-v1+json";
const TARBALL = "application/vnd.bun.install-tarball";
const CACHE = "bun-wasm-install-v1";

/** Cache npm downloads across playground runs, without caching ordinary user fetches. */
export async function installFetch(url: string, options: RequestInit): Promise<Response> {
  const header = new Headers(options.headers).get("accept") ?? "";
  const accept = header.split(";", 1)[0];
  const refresh = header.includes("; no-cache");
  if (options.method !== "GET" || accept !== METADATA && accept !== TARBALL) {
    return fetch(url, options);
  }
  if (accept === METADATA || typeof caches === "undefined" || new Headers(options.headers).has("authorization")) {
    return packageFetch(url, options);
  }
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const cached = await cache.match(url);
    if (cached && !refresh) return cached;
  } catch {
    // Private browsing and exhausted quotas must not prevent an install.
  }
  const response = await packageFetch(url, options);
  if (response.ok && cache) await store(cache, url, response.clone());
  return response;
}

async function store(cache: Cache, url: string, response: Response): Promise<void> {
  try {
    await cache.put(url, response);
  } catch {
    // The guest still receives the original response when persistence is unavailable.
  }
}
