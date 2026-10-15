import { assetBuild } from "../../web/src/startup-cache";

const CACHE = "bunwasm-sandbox-deps";

export async function depsCacheKey(engine: string, engineBuild: string | null): Promise<string | null> {
  const templateBuild = assetBuild("template.json");
  if (!templateBuild || !engineBuild) return null;
  return new URL(`./__startup/deps/${engine}/${engineBuild}-${templateBuild}.json`, location.href).href;
}

export async function readDeps(key: string): Promise<string | null> {
  try {
    if (localStorage.getItem(`${CACHE}:${key}`) !== "1") return null;
    return await (await (await caches.open(CACHE)).match(key))?.text() ?? null;
  } catch {
    return null;
  }
}

export async function writeDeps(key: string, text: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(key, new Response(text, { headers: { "content-type": "application/json" } }));
    localStorage.setItem(`${CACHE}:${key}`, "1");
    // Keep one bundle per engine. Editing a template or changing an engine invalidates its output.
    const directory = new URL(".", key).href;
    const stale = (await cache.keys()).filter((request) => request.url.startsWith(directory) && request.url !== key);
    for (const request of stale) localStorage.removeItem(`${CACHE}:${request.url}`);
    await Promise.all(stale.map((request) => cache.delete(request)));
  } catch {
    // A full or disabled cache must not stop a working dev server.
  }
}
