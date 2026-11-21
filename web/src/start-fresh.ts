import { deleteWorkspace } from "waffle";
import { isStorageFull } from "./storage-full";

/** Shown when another tab still holds the workspace; Waffle then deletes nothing. */
export const START_FRESH_BUSY = "This workspace is open in another tab. Close the other tabs, then press Start fresh again.";

// Deleting the stored workspace cannot help when the browser itself lacks what the filesystem
// needs, or when the settings are wrong.
const BROWSER_LIMITS = new Set(["UNSUPPORTED_VFS", "INVALID_VFS_SETTINGS", "UNSUPPORTED_VFS_CAPABILITY"]);

type FilesystemState = { readonly status: string; readonly error?: unknown };

/**
 * Whether startup failed because the stored workspace cannot be opened: Waffle reports a stored
 * format it cannot read as INVALID_VFS_FORMAT, and a filesystem that failed to open for any other
 * reason is just as stuck. Full storage and a browser that lacks what the filesystem needs are
 * not: the workspace itself is fine, so they keep their Retry and get no Start fresh.
 */
export function unreadableWorkspace(error: unknown, state: FilesystemState | undefined): boolean {
  if (codes(error).includes("INVALID_VFS_FORMAT") || codes(state?.error).includes("INVALID_VFS_FORMAT")) return true;
  if (state?.status !== "failed") return false;
  const cause = state.error ?? error;
  return !isStorageFull(cause) && !isStorageFull(error) && !codes(cause).some(code => BROWSER_LIMITS.has(code));
}

/** The VfsError codes along an error's cause chain. Errors cross the filesystem worker as VfsError. */
function codes(error: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = "cause" in current ? current.cause : undefined) {
    seen.add(current);
    if ("name" in current && current.name === "VfsError" && "code" in current && typeof current.code === "string") found.push(current.code);
  }
  return found;
}

/**
 * Deletes the named fast-mode workspace so the page can open it fresh. The failed runtime is
 * disposed first, so it holds neither store when Waffle claims them. "busy" means another tab or
 * handle still holds the workspace and nothing was deleted.
 */
export async function startFresh(dispose: (() => Promise<unknown>) | undefined, name: string, remove = deleteWorkspace): Promise<"deleted" | "missing" | "busy"> {
  try { await dispose?.(); } catch (error) { console.warn("Start fresh: the failed runtime did not dispose cleanly", error); }
  return remove({ mode: "fast", name });
}
