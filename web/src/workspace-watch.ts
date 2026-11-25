import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import type { FilesystemWatch, WatchBatch } from "waffle/fs/watch";

type Filesystem = Pick<Runtime["filesystem"], "fork">;

export type ReconcileReason = "rebound" | "ancestor-moved" | "fs-overflow" | "recovered";

export interface WorkspaceWatchOptions {
  readonly fs: Filesystem;
  /** Target directory absolute path (e.g. "/home/user/app" or "/home/user"). */
  readonly targetPath: string;
  readonly onPaths: (relativePaths: readonly string[]) => void | Promise<void>;
  readonly onReconcile: (reason: ReconcileReason) => void | Promise<void>;
  readonly coalesceMs?: number;
  readonly signal?: AbortSignal;
  /** Optional custom client factory for deterministic unit tests. */
  readonly createClient?: (fs: Filesystem) => FilesystemClientLike;
  /** Optional backoff schedule override for tests. */
  readonly backoffMs?: readonly number[];
}

export interface FilesystemClientLike {
  asyncCall(method: "preopen", args: [string]): Promise<number>;
  asyncCall(method: "resolve", args: [number, string, boolean]): Promise<{ node: number; ino?: bigint | number }>;
  asyncCall(method: "resolvePath", args: [string]): Promise<{ path: string; kind: string; ino?: bigint | number } | undefined>;
  asyncCall(method: "stat", args: [number]): Promise<{ ino: bigint | number }>;
  retain(node: number): void;
  release(node: number): void;
  watch(handle: number, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<Pick<FilesystemWatch, "next" | "close">>;
  dispose(): void;
}

export interface WorkspaceWatchHandle {
  readonly ready: Promise<void>;
  rebind(options?: { reconcile?: boolean; signal?: AbortSignal }): Promise<void>;
  stop(): void;
}

const DEFAULT_BACKOFF = [100, 250, 500, 1000] as const;

function normalizeRelTarget(targetPath: string): string {
  return targetPath.replace(/^\/+|\/+$/g, "");
}

function computeAncestorPaths(relTarget: string): Set<string> {
  const parts = relTarget.split("/").filter(Boolean);
  const ancestors = new Set<string>();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    ancestors.add(current);
  }
  return ancestors;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function resolveTargetIno(
  client: FilesystemClientLike,
  rootHandle: number,
  relTarget: string,
): Promise<string | null> {
  try {
    const resolved = await client.asyncCall("resolve", [rootHandle, relTarget || ".", true]);
    if (resolved.ino !== undefined) return String(resolved.ino);
    client.retain(resolved.node);
    try {
      const st = await client.asyncCall("stat", [resolved.node]);
      return String(st.ino);
    } finally {
      client.release(resolved.node);
    }
  } catch {
    return null;
  }
}

/**
 * 100% async immutable-root filesystem watcher using `FilesystemClient(fs.fork())`.
 * Watches `"."` from preopened `"/"` with exact `retain`/`release` pairing and
 * disposes its forked client immediately on abort.
 */
export function startWorkspaceWatch(options: WorkspaceWatchOptions): WorkspaceWatchHandle {
  const relTarget = normalizeRelTarget(options.targetPath);
  const relPrefix = relTarget ? `${relTarget}/` : "";
  const ancestorPaths = computeAncestorPaths(relTarget);
  const coalesceMs = options.coalesceMs ?? 100;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF;
  const createClient = options.createClient ?? ((fs: Filesystem) => new FilesystemClient(fs.fork()) as unknown as FilesystemClientLike);

  const lifetime = new AbortController();
  let stopped = false;

  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    clearCoalesce();
    disposeSession();
  };

  if (options.signal) {
    if (options.signal.aborted) stopAll();
    else options.signal.addEventListener("abort", stopAll, { once: true });
  }

  let activeClient: FilesystemClientLike | null = null;
  let activeRootHandle: number | null = null;
  let activeRootNode: number | null = null;
  let activeWatch: Pick<FilesystemWatch, "next" | "close"> | null = null;
  let watchedIno: string | null = null;
  let loopRunning = false;

  const pendingPaths = new Set<string>();
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let deliverChain: Promise<void> = Promise.resolve();

  function clearCoalesce(): void {
    if (coalesceTimer !== undefined) {
      clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
    }
    pendingPaths.clear();
  }

  function flushCoalesced(): void {
    coalesceTimer = undefined;
    if (stopped || pendingPaths.size === 0) return;
    const batch = Array.from(pendingPaths);
    pendingPaths.clear();
    deliverChain = deliverChain.then(async () => {
      if (stopped) return;
      await options.onPaths(batch);
    }).catch(() => {});
  }

  function enqueuePath(relPath: string): void {
    if (stopped) return;
    pendingPaths.add(relPath);
    if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(flushCoalesced, coalesceMs);
  }

  function disposeSession(): void {
    const watch = activeWatch;
    const client = activeClient;
    const rootNode = activeRootNode;
    activeWatch = null;
    activeClient = null;
    activeRootHandle = null;
    activeRootNode = null;
    if (watch) void watch.close().catch(() => {});
    if (client && rootNode !== null) {
      try { client.release(rootNode); } catch {}
    }
    if (client) {
      try { client.dispose(); } catch {}
    }
  }

  async function openSession(reopenSignal?: AbortSignal): Promise<void> {
    if (stopped) throw new DOMException("Watcher stopped", "AbortError");
    reopenSignal?.throwIfAborted();
    disposeSession();

    const client = createClient(options.fs);
    const onStop = () => { try { client.dispose(); } catch {} };
    const onReopenAbort = () => { try { client.dispose(); } catch {} };
    lifetime.signal.addEventListener("abort", onStop, { once: true });
    reopenSignal?.addEventListener("abort", onReopenAbort, { once: true });

    let retainedNode: number | null = null;
    let openedWatch: Pick<FilesystemWatch, "next" | "close"> | null = null;
    try {
      if (stopped) throw new DOMException("Watcher stopped", "AbortError");
      reopenSignal?.throwIfAborted();
      const rootHandle = await client.asyncCall("preopen", ["/"]);
      if (stopped) throw new DOMException("Watcher stopped", "AbortError");
      reopenSignal?.throwIfAborted();
      const rootRes = await client.asyncCall("resolve", [rootHandle, ".", true]);
      if (stopped) throw new DOMException("Watcher stopped", "AbortError");
      reopenSignal?.throwIfAborted();

      client.retain(rootRes.node);
      retainedNode = rootRes.node;
      openedWatch = await client.watch(rootRes.node, { recursive: true, signal: lifetime.signal });
      if (stopped || reopenSignal?.aborted) {
        throw reopenSignal?.reason ?? new DOMException("Watcher aborted", "AbortError");
      }
      // Post-subscribe target inode resolution BEFORE resolving ready.
      watchedIno = await resolveTargetIno(client, rootHandle, relTarget);
      if (stopped || reopenSignal?.aborted) {
        throw reopenSignal?.reason ?? new DOMException("Watcher aborted", "AbortError");
      }

      activeClient = client;
      activeRootHandle = rootHandle;
      activeRootNode = retainedNode;
      activeWatch = openedWatch;
      retainedNode = null;
      openedWatch = null;
    } catch (error) {
      if (openedWatch) void openedWatch.close().catch(() => {});
      if (retainedNode !== null) {
        try { client.release(retainedNode); } catch {}
      }
      try { client.dispose(); } catch {}
      throw error;
    } finally {
      lifetime.signal.removeEventListener("abort", onStop);
      reopenSignal?.removeEventListener("abort", onReopenAbort);
    }
  }

  function processWatchEvents(events: readonly { readonly name: string | null }[]): boolean {
    let needsAncestorCheck = false;
    for (const event of events) {
      if (event.name === null) {
        needsAncestorCheck = true;
        continue;
      }
      const cleanName = event.name.replace(/^\/+/, "");
      if (ancestorPaths.has(cleanName)) {
        needsAncestorCheck = true;
        continue;
      }
      if (!relPrefix) {
        enqueuePath(cleanName);
      } else if (cleanName.startsWith(relPrefix)) {
        enqueuePath(cleanName.slice(relPrefix.length));
      }
    }
    return needsAncestorCheck;
  }

  async function checkAncestorInode(client: FilesystemClientLike, rootHandle: number): Promise<void> {
    if (activeClient !== client || activeRootHandle !== rootHandle) return;
    const currentIno = await resolveTargetIno(client, rootHandle, relTarget);
    if (stopped) return;
    const reason: ReconcileReason = currentIno !== watchedIno ? "rebound" : "ancestor-moved";
    watchedIno = currentIno;
    clearCoalesce();
    deliverChain = deliverChain.then(async () => {
      if (!stopped) await options.onReconcile(reason);
    }).catch(() => {});
  }

  async function pumpOnce(): Promise<boolean> {
    const watch = activeWatch;
    const client = activeClient;
    const rootHandle = activeRootHandle;
    if (!watch || !client || rootHandle === null) return false;
    let batch: WatchBatch;
    try {
      batch = await watch.next();
    } catch {
      if (!stopped) await recoverFromDisruption(false);
      return !stopped;
    }
    if (stopped) return false;
    if (batch.kind === "overflow" || batch.kind === "closed") {
      await recoverFromDisruption(batch.kind === "overflow");
      return !stopped;
    }
    if (processWatchEvents(batch.events)) {
      await checkAncestorInode(client, rootHandle);
    }
    return !stopped;
  }

  function startPumpLoop(): void {
    if (loopRunning || stopped) return;
    loopRunning = true;
    void (async () => {
      try {
        while (!stopped && await pumpOnce()) {
          // Keep pumping until stopped or watch is closed.
        }
      } finally {
        loopRunning = false;
      }
    })();
  }

  async function recoverFromDisruption(isOverflow: boolean): Promise<void> {
    clearCoalesce();
    disposeSession();
    for (let attempt = 0; !stopped; attempt++) {
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 1000;
      if (attempt > 0 && !(await abortableSleep(delay, lifetime.signal))) return;
      try {
        await openSession();
        if (stopped) return;
        deliverChain = deliverChain.then(async () => {
          if (!stopped) await options.onReconcile(isOverflow ? "fs-overflow" : "recovered");
        }).catch(() => {});
        return;
      } catch {
        if (stopped) return;
      }
    }
  }

  const ready = openSession().then(() => {
    if (!stopped) startPumpLoop();
  });

  async function rebind(rebindOptions: { reconcile?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (stopped) throw new DOMException("Watcher stopped", "AbortError");
    const sig = rebindOptions.signal;
    sig?.throwIfAborted();
    if (!activeClient || !activeWatch || activeRootHandle === null) {
      await openSession(sig);
      if (!stopped) startPumpLoop();
    } else {
      const client = activeClient;
      const rootHandle = activeRootHandle;
      // Honor signal during resolve by racing with abort; do not dispose healthy watcher on abort.
      const resolvedIno = await new Promise<string | null>((resolve, reject) => {
        if (sig?.aborted) {
          reject(sig.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => reject(sig?.reason ?? new DOMException("Aborted", "AbortError"));
        sig?.addEventListener("abort", onAbort, { once: true });
        resolveTargetIno(client, rootHandle, relTarget).then(
          (val) => { sig?.removeEventListener("abort", onAbort); resolve(val); },
          (err) => { sig?.removeEventListener("abort", onAbort); reject(err); },
        );
      });
      if (stopped) throw new DOMException("Watcher stopped", "AbortError");
      sig?.throwIfAborted();
      watchedIno = resolvedIno;
    }
    if (rebindOptions.reconcile !== false && !sig?.aborted && !stopped) {
      await options.onReconcile("rebound");
    }
  }

  return {
    ready,
    rebind,
    stop: stopAll,
  };
}
