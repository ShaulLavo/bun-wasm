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

export function entryAssetUrl(path: string, base: string = location.href): URL {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "./";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  return new URL(`${dir}${entryAssetName(file)}`, base);
}
