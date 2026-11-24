/**
 * Resolves content-hashed entry/worker filenames published by web/build.ts and sandbox/build.ts
 * into `globalThis.__bunwasmAssets`, falling back to plain filenames in tests and package consumers.
 */
const ENTRY_ASSET_PATTERN = /^entry-[\w.-]+\.(?:js|css)$/;

export function entryAssetName(name: string): string {
  if (!("__bunwasmAssets" in globalThis)) return name;
  const assets: unknown = Reflect.get(globalThis, "__bunwasmAssets");
  if (!assets || typeof assets !== "object" || !Object.hasOwn(assets, name)) return name;
  const value: unknown = Reflect.get(assets, name);
  return typeof value === "string" && ENTRY_ASSET_PATTERN.test(value) ? value : name;
}

export function entryAssetUrl(path: string, base: string = globalThis.location?.href ?? import.meta.url): URL {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "./";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  return new URL(`${dir}${entryAssetName(file)}`, base);
}

/**
 * Returns the service worker registration URL, appending `?v=<hash>` when the build records
 * `sw.js` in `globalThis.__bunwasmBuilds`. Keeping the `/sw.js` pathname preserves header rules
 * and observer proxying while changing the script URL on every `sw.js` update so browsers always
 * trigger the W3C Service Worker update algorithm even when `updateViaCache: "none"` is already set.
 */
export function swScriptUrl(): string {
  if (!("__bunwasmBuilds" in globalThis)) return "./sw.js";
  const builds: unknown = Reflect.get(globalThis, "__bunwasmBuilds");
  if (!builds || typeof builds !== "object") return "./sw.js";
  const digest: unknown = Reflect.get(builds, "sw.js");
  return typeof digest === "string" && digest.length > 0 ? `./sw.js?v=${digest.slice(0, 16)}` : "./sw.js";
}
