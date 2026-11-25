import { deleteWorkspace, openIdleWorkspace } from "waffle";
import { acquireLockHandle, presenceLockName } from "./workspace-claims";

/** Shown when another tab still holds the workspace; Waffle then deletes nothing. */
export const START_FRESH_BUSY = "This workspace is open in another tab. Close the other tabs, then press Start fresh again.";

type FilesystemState = { readonly status: string; readonly error?: unknown };

/**
 * Whether startup failed because Waffle cannot read the stored workspace's format
 * (INVALID_VFS_FORMAT). Every other failure (a worker script that did not load, a lost
 * IndexedDB connection, full storage, running out of memory) can pass on a retry with the same
 * workspace, so it keeps the Retry path and gets no Start fresh.
 */
export function unreadableWorkspace(error: unknown, state: FilesystemState | undefined): boolean {
  return codes(error).includes("INVALID_VFS_FORMAT") || codes(state?.error).includes("INVALID_VFS_FORMAT");
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

const waffle = { open: openIdleWorkspace, remove: deleteWorkspace };

export interface StartFreshOptions {
  /** Optional custom Web Locks manager for deterministic tests. */
  locks?: Pick<LockManager, "request">;
  /** Set false to bypass presenceLock (only for non-WebLocks legacy tests). Default true when navigator.locks exists. */
  usePresenceLock?: boolean;
}

/**
 * Deletes the named fast-mode workspace, but only while it still cannot be opened, so the page
 * can open it fresh. Disposes the failed runtime first (releasing its own shared presenceLock),
 * then acquires `presenceLock` exclusively (`ifAvailable: true`) continuously across BOTH
 * `openIdleWorkspace` (`INVALID_VFS_FORMAT`) AND `deleteWorkspace` to prevent TOCTOU races.
 */
export async function startFresh(
  dispose: (() => Promise<unknown>) | undefined,
  name: string,
  storage = waffle,
  options: StartFreshOptions = {},
): Promise<"deleted" | "missing" | "busy" | "readable"> {
  try { await dispose?.(); } catch (error) { console.warn("Start fresh: the failed runtime did not dispose cleanly", error); }

  const locks = options.locks ?? (typeof navigator !== "undefined" ? navigator.locks : undefined);
  const usePresence = (options.usePresenceLock ?? true) && locks !== undefined;

  let presenceHandle: { release(): void } | null = null;
  if (usePresence) {
    presenceHandle = await acquireLockHandle(presenceLockName(name), {
      mode: "exclusive",
      ifAvailable: true,
      locks,
    });
    if (!presenceHandle) return "busy";
  }

  try {
    const selection = { mode: "fast", name } as const;
    let opened: Awaited<ReturnType<typeof openIdleWorkspace>>;
    try { opened = await storage.open(selection); } catch (error) {
      if (!codes(error).includes("INVALID_VFS_FORMAT")) throw error;
      return await storage.remove(selection);
    }
    if (typeof opened === "string") return opened;
    await opened.close();
    return "readable";
  } finally {
    presenceHandle?.release();
  }
}
