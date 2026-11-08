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

export async function stageReleasePackages(source: string, fixture: string, download: typeof releaseDownload = releaseDownload): Promise<void> {
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const locked = lockedReleasePackages(await readFile(join(source, "bun.lock"), "utf8"));
  const archives = join(fixture, "release-archives");
  await mkdir(archives, { recursive: true });
  const overrides: Record<string, string> = {};
  for (const pin of locked) {
    const response = await download(pin.url);
    if (!response.ok) throw new Error(`Release package download failed: ${response.status}`);
    const bytes = await response.bytes();
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== pin.integrity)
      throw new Error(`Locked release integrity mismatch: ${pin.name}`);
    const archive = join(archives, `${releaseCacheKey(pin.url)}.tgz`);
    await writeFile(archive, bytes);
    overrides[pin.name] = archive;
  }
  await writeFile(join(fixture, "package.json"), JSON.stringify({ ...manifest, overrides: { ...manifest.overrides, ...overrides } }));
}

export function verifyStagedResolutions(original: string, staged: string): void {
  const before = lockPackages(original);
  const after = lockPackages(staged);
  const replaced = new Set(lockedReleasePackages(original).map(pin => pin.name));
  for (const [name, entry] of Object.entries(before)) {
    if (replaced.has(name)) continue;
    if (JSON.stringify(after[name]) !== JSON.stringify(entry))
      throw new Error(`Fixture staging changed a non-release resolution: ${name}`);
  }
}
