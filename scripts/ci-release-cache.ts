import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const releaseCacheLimits = {
  bootstrap: 192 * 1024 * 1024,
  local: 512 * 1024 * 1024,
  unusedMs: 7 * 24 * 60 * 60 * 1000,
};

type Entry = { name: string; bytes: number; modified: number };

async function entries(directory: string): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isDirectory() && /^\.download-/.test(name)) {
      await rm(path, { recursive: true });
      continue;
    }
    if (!stat.isFile() || !/^[a-f0-9]{64}$/.test(name)) throw new Error(`Unexpected release cache member: ${path}`);
    result.push({ name, bytes: stat.size, modified: stat.mtimeMs });
  }
  return result;
}

async function retain(directory: string, assets: Entry[], maximumBytes: number, oldest = -Infinity): Promise<number> {
  assets.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  let bytes = 0;
  for (const asset of assets) {
    if (asset.modified < oldest || bytes + asset.bytes > maximumBytes) {
      await rm(join(directory, asset.name));
      continue;
    }
    bytes += asset.bytes;
  }
  return bytes;
}

export async function retainReleaseCaches(local: string, bootstrap: string, now = Date.now()) {
  const shared = await entries(bootstrap);
  const sharedNames = new Set(shared.map(asset => asset.name));
  const owned: Entry[] = [];
  for (const asset of await entries(local)) {
    if (sharedNames.has(asset.name)) await rm(join(local, asset.name));
    else owned.push(asset);
  }
  return {
    bootstrapBytes: await retain(bootstrap, shared, releaseCacheLimits.bootstrap),
    localBytes: await retain(local, owned, releaseCacheLimits.local, now - releaseCacheLimits.unusedMs),
  };
}

if (import.meta.main) {
  const [local, bootstrap, extra] = process.argv.slice(2);
  if (!local || !bootstrap || extra) throw new Error("Usage: ci-release-cache.ts LOCAL_POOL BOOTSTRAP_POOL");
  console.log(JSON.stringify(await retainReleaseCaches(local, bootstrap)));
}
