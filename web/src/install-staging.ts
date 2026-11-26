/** Names of the staging directories `bun install` creates in the guest's temporary directory
 * while it prepares packages early (`crates/bunwasm-runtime/src/install/early.rs`). */
const EARLY_STAGING_PREFIX = "bun-wasm-early-";

/** The part of a workspace filesystem this needs: Waffle's shared or memory filesystem. */
interface StagingFilesystem {
  lookup(path: string): Promise<StagingEntry | undefined> | StagingEntry | undefined;
  remove(path: string): Promise<boolean> | boolean;
}
type StagingEntry = { kind: string; children?: ReadonlyMap<string, unknown> };

/**
 * Removes the staging that installs killed mid-way (a reload, a closed tab) left in `temp`.
 * An install removes only its own staging, so leftovers are the host's to clear. Call this
 * only while no guest process can run in the workspace: at boot, before any guest starts.
 */
export async function clearEarlyStaging(fs: StagingFilesystem, temp = "/tmp"): Promise<number> {
  const entry = await fs.lookup(temp);
  if (entry?.kind !== "dir" || !entry.children) return 0;
  const stale = Array.from(entry.children.keys()).filter(name => name.startsWith(EARLY_STAGING_PREFIX));
  for (const name of stale) await fs.remove(`${temp}/${name}`);
  return stale.length;
}
