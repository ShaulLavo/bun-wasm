import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseCacheKey, releaseDownload } from "./ci-release-download";

function lockPackages(lockfile: string): Record<string, unknown> {
  const lock: unknown = Bun.JSONC.parse(lockfile);
  if (!lock || typeof lock !== "object" || !("packages" in lock) || !lock.packages || typeof lock.packages !== "object")
    throw new Error("Missing locked packages");
  return Object.fromEntries(Object.entries(lock.packages));
}

export function lockedReleasePackages(lockfile: string): { name: string; url: string; integrity: string }[] {
  return Object.values(lockPackages(lockfile)).flatMap((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error("Invalid locked package");
    const match = /^(.+)@(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^\s]+)$/.exec(entry[0]);
    if (!match) return [];
    const integrity: unknown = entry.at(-1);
    if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error("Missing release integrity");
    return [{ name: match[1]!, url: match[2]!, integrity }];
  });
}

export function rebindReleaseLocations(value: unknown, locations: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return translateString(value, locations);
  if (Array.isArray(value)) return value.map(entry => rebindReleaseLocations(entry, locations));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebindReleaseLocations(entry, locations)]));
}

function translateString(value: string, locations: ReadonlyMap<string, string>): string {
  for (const [original, local] of locations) {
    if (value === original) return local;
    if (value.endsWith(`@${original}`)) return value.slice(0, -original.length) + local;
  }
  return value;
}

export async function stageReleasePackages(source: string, fixture: string, download: typeof releaseDownload = releaseDownload, archives = join(fixture, "release-archives")): Promise<Map<string, string>> {
  const manifest: unknown = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const lockfile = await readFile(join(source, "bun.lock"), "utf8");
  const lock: unknown = Bun.JSONC.parse(lockfile);
  const locations = new Map<string, string>();
  await mkdir(archives, { recursive: true });
  for (const pin of lockedReleasePackages(lockfile)) {
    const response = await download(pin.url);
    if (!response.ok) throw new Error(`Release package download failed: ${response.status}`);
    const bytes = await response.bytes();
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pin.integrity)
      throw new Error(`Locked release integrity mismatch: ${pin.name}`);
    const archive = join(archives, `${releaseCacheKey(pin.url)}.tgz`);
    await writeFile(archive, bytes);
    locations.set(pin.url, archive);
  }
  await writeFile(join(fixture, "package.json"), JSON.stringify(rebindReleaseLocations(manifest, locations)));
  await writeFile(join(fixture, "bun.lock"), JSON.stringify(rebindReleaseLocations(lock, locations)));
  return locations;
}

export function verifyStagedResolutions(original: string, staged: string, locations: ReadonlyMap<string, string> = new Map()): void {
  const restored = rebindReleaseLocations(Bun.JSONC.parse(staged), new Map(Array.from(locations, ([url, path]) => [path, url])));
  if (JSON.stringify(Bun.JSONC.parse(original)) !== JSON.stringify(restored))
    throw new Error("Fixture staging changed a non-release resolution or locked metadata");
}
