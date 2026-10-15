import { assetBuild } from "../../web/src/startup-cache";

const CACHE = "bunwasm-sandbox-deps";

export function depsCacheKey(engine: string, engineBuild: string | null, templateFile: string): string | null {
  const templateBuild = assetBuild(templateFile);
  if (!templateBuild || !engineBuild) return null;
  return new URL(`./__startup/deps/${templateFile}/${engine}/${engineBuild}-${templateBuild}.bin`, location.href).href;
}

export async function readDeps(key: string): Promise<Uint8Array | null> {
  try {
    if (localStorage.getItem(`${CACHE}:${key}`) !== "1") return null;
    const response = await (await caches.open(CACHE)).match(key);
    return response ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function writeDeps(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(key, new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream" } }));
    localStorage.setItem(`${CACHE}:${key}`, "1");
    // Keep one compiled dependency graph per engine and template.
    const directory = new URL(".", key).href;
    const stale = (await cache.keys()).filter((request) => request.url.startsWith(directory) && request.url !== key);
    for (const request of stale) localStorage.removeItem(`${CACHE}:${request.url}`);
    await Promise.all(stale.map((request) => cache.delete(request)));
  } catch {
    // A full or disabled cache must not stop a working dev server.
  }
}
