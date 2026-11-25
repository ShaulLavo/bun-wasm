import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
export { acquireLockHandle, presenceLockName, raceAbort, type LockHandle } from "./web-locks";
import { acquireLockHandle, raceAbort } from "./web-locks";

type Filesystem = Runtime["filesystem"];

const FS_WORKER_PEER_CHANNEL = "bun-wasm:fs-worker-peer";
const CLAIMS_DB_NAME = "bun-wasm-workspace-claims";

export function pageAliveLockName(workspaceName: string, tabId: string): string {
  return `bun-wasm:workspace:page-alive:${workspaceName}:${tabId}`;
}

export function liveWritersLockName(workspaceName: string): string {
  return `bun-wasm:workspace:live-writers:${workspaceName}`;
}

function claimLockName(workspaceName: string, claimId: string): string {
  return `bun-wasm:workspace:claim:${workspaceName}:${claimId}`;
}

export interface PeerWorkerIdentity {
  readonly tabId: string;
  readonly pageAliveLock: string;
  readonly workerInstanceId: string;
  readonly workerClientId: string;
  readonly peerAliveLock: string;
}

export interface PartialWorkerIdentity {
  readonly workerClientId: string | null;
  readonly peerAliveLock: string | null;
}

export interface WriterClaim {
  readonly peerAliveLock: string;
  readonly claimLock: string;
  readonly pageAliveLock: string;
}

export interface WriterClaimHandle {
  readonly claim: WriterClaim;
  release(deadlineMs?: number): Promise<void>;
}

interface ClaimsBackend {
  addWriterClaim(workspace: string, claim: WriterClaim): Promise<void>;
  removeWriterClaim(workspace: string, claimLock: string): Promise<void>;
  listWriterClaims(workspace: string): Promise<WriterClaim[]>;
  close(): void;
}

export type LockManagerLike = Pick<LockManager, "request" | "query">;

export interface ClaimsEnvironment {
  readonly locks: LockManagerLike;
  readonly store: ClaimsBackend;
}

export async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<{ timedOut: false; rejected: false; value: T } | { timedOut: false; rejected: true; error: unknown } | { timedOut: true; rejected: false }> {
  const remaining = deadlineMs - performance.now();
  if (remaining <= 0) return { timedOut: true, rejected: false };
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, rejected: false });
    }, remaining);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, rejected: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, rejected: true, error });
      },
    );
  });
}

export interface WorkerIdentityObserver {
  readonly identityReady: Promise<PeerWorkerIdentity>;
  getIdentity(): PeerWorkerIdentity | null;
  getPartialWorkerIdentity(): PartialWorkerIdentity;
  dispose(): void;
}

/**
 * Must be constructed BEFORE `createRuntime({ workerURL: ... + "#attach:" + workerInstanceId })`
 * so initial boot announcements from the worker are never missed.
 */
export function createWorkerIdentityObserver(
  workerInstanceId: string,
  pageTabId: string,
  pageAliveLock: string,
  channelFactory: (name: string) => BroadcastChannel = (name) => new BroadcastChannel(name),
): WorkerIdentityObserver {
  let workerClientId: string | null = null;
  let peerAliveLock: string | null = null;
  let resolvedIdentity: PeerWorkerIdentity | null = null;
  let disposed = false;

  const deferred = Promise.withResolvers<PeerWorkerIdentity>();
  void deferred.promise.catch(() => {});

  const channel = channelFactory(FS_WORKER_PEER_CHANNEL);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    channel.onmessage = null;
    try { channel.close(); } catch {}
  };

  const tryResolve = () => {
    if (resolvedIdentity || !workerClientId || !peerAliveLock) return;
    resolvedIdentity = {
      tabId: pageTabId,
      pageAliveLock,
      workerInstanceId,
      workerClientId,
      peerAliveLock,
    };
    cleanup();
    deferred.resolve(resolvedIdentity);
  };

  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (disposed) return;
    const msg = event.data as {
      type?: unknown;
      tabId?: unknown;
      workerClientId?: unknown;
      peerAliveLock?: unknown;
    } | null;
    if (!msg || msg.type !== "fs-worker-identity" || msg.tabId !== workerInstanceId) return;
    if (typeof msg.workerClientId === "string" && msg.workerClientId) workerClientId = msg.workerClientId;
    if (typeof msg.peerAliveLock === "string" && msg.peerAliveLock) peerAliveLock = msg.peerAliveLock;
    tryResolve();
  };

  const sendQuery = () => {
    if (disposed) return;
    try {
      channel.postMessage({ type: "query-fs-worker-identity", tabId: workerInstanceId });
    } catch {}
  };
  const timer = setInterval(sendQuery, 100);
  sendQuery();

  return {
    identityReady: deferred.promise,
    getIdentity: () => resolvedIdentity,
    getPartialWorkerIdentity: () => ({ workerClientId, peerAliveLock }),
    dispose: () => {
      if (!resolvedIdentity && !disposed) {
        deferred.reject(new DOMException("Worker identity observer disposed", "AbortError"));
      }
      cleanup();
    },
  };
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException("Claims transaction aborted", "AbortError"));
    transaction.onerror = () => {};
  });
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface StoredClaimsRow {
  workspace: string;
  claims: WriterClaim[];
}

class WorkspaceClaimsStore implements ClaimsBackend {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private closed = false;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly name = CLAIMS_DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("WorkspaceClaimsStore is closed"));
    if (this.database) return Promise.resolve(this.database);
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("claims")) {
          request.result.createObjectStore("claims", { keyPath: "workspace" });
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Workspace claims store is blocked"));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          if (this.database === db) this.database = null;
        };
        if (this.closed) {
          db.close();
          reject(new Error("WorkspaceClaimsStore closed during open"));
          return;
        }
        this.database = db;
        resolve(db);
      };
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async transaction<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(["claims"], mode, mode === "readwrite" ? { durability: "strict" } : undefined);
    const done = completed(tx);
    try {
      const result = await fn(tx.objectStore("claims"));
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async addWriterClaim(workspace: string, claim: WriterClaim): Promise<void> {
    await this.transaction("readwrite", async (store) => {
      const existing = (await requested(store.get(workspace))) as StoredClaimsRow | undefined;
      const list = existing?.claims ? existing.claims.filter((c) => c.claimLock !== claim.claimLock) : [];
      list.push(claim);
      store.put({ workspace, claims: list } satisfies StoredClaimsRow);
    });
  }

  async removeWriterClaim(workspace: string, claimLock: string): Promise<void> {
    await this.transaction("readwrite", async (store) => {
      const existing = (await requested(store.get(workspace))) as StoredClaimsRow | undefined;
      if (!existing?.claims?.length) return;
      const next = existing.claims.filter((c) => c.claimLock !== claimLock);
      if (next.length === 0) store.delete(workspace);
      else store.put({ workspace, claims: next } satisfies StoredClaimsRow);
    });
  }

  async listWriterClaims(workspace: string): Promise<WriterClaim[]> {
    return this.transaction("readonly", async (store) => {
      const existing = (await requested(store.get(workspace))) as StoredClaimsRow | undefined;
      return existing?.claims ? [...existing.claims] : [];
    });
  }

  close(): void {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}

export class MemoryClaimsStore implements ClaimsBackend {
  private readonly rows = new Map<string, WriterClaim[]>();

  async addWriterClaim(workspace: string, claim: WriterClaim): Promise<void> {
    const list = (this.rows.get(workspace) ?? []).filter((c) => c.claimLock !== claim.claimLock);
    list.push(claim);
    this.rows.set(workspace, list);
  }

  async removeWriterClaim(workspace: string, claimLock: string): Promise<void> {
    const existing = this.rows.get(workspace);
    if (!existing) return;
    const next = existing.filter((c) => c.claimLock !== claimLock);
    if (next.length === 0) this.rows.delete(workspace);
    else this.rows.set(workspace, next);
  }

  async listWriterClaims(workspace: string): Promise<WriterClaim[]> {
    return [...(this.rows.get(workspace) ?? [])];
  }

  close(): void {
    this.rows.clear();
  }
}

let defaultClaimsStore: WorkspaceClaimsStore | null = null;
function sharedClaimsStore(): WorkspaceClaimsStore {
  return (defaultClaimsStore ??= new WorkspaceClaimsStore());
}

/**
 * Commit-before-write crash-fence claim:
 * Acquires exclusive `claimLock`, awaits IDB commit BEFORE returning, and releases cleanly.
 */
export async function acquireWriterClaim(
  workspace: string,
  identity: PeerWorkerIdentity,
  ownClaimIds: Set<string>,
  options: { signal?: AbortSignal; env?: ClaimsEnvironment } = {},
): Promise<WriterClaimHandle> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const locks = options.env?.locks ?? navigator.locks;
  const store = options.env?.store ?? sharedClaimsStore();
  const claimId = crypto.randomUUID();
  const claimLock = claimLockName(workspace, claimId);
  const claim: WriterClaim = {
    peerAliveLock: identity.peerAliveLock,
    claimLock,
    pageAliveLock: identity.pageAliveLock,
  };

  const lockHandle = await acquireLockHandle(claimLock, { mode: "exclusive", signal, locks });
  if (!lockHandle) throw new Error("Failed to acquire writer claim lock");
  ownClaimIds.add(claimLock);

  const registrationPromise = store.addWriterClaim(workspace, claim);
  try {
    await raceAbort(registrationPromise, signal);
  } catch (error) {
    // Best-effort cleanup of any late IDB commit, then immediately release claim lock.
    void registrationPromise.then(() => store.removeWriterClaim(workspace, claimLock)).catch(() => {});
    ownClaimIds.delete(claimLock);
    lockHandle.release();
    throw error;
  }

  let released = false;
  return {
    claim,
    async release(deadlineMs?: number): Promise<void> {
      if (released) return;
      released = true;
      try {
        const removeTask = registrationPromise
          .catch(() => {})
          .then(() => store.removeWriterClaim(workspace, claimLock))
          .catch(() => {});
        if (deadlineMs !== undefined) {
          await withDeadline(removeTask, deadlineMs);
        } else {
          await removeTask;
        }
      } finally {
        ownClaimIds.delete(claimLock);
        lockHandle.release();
      }
    },
  };
}

export async function withWriterClaim<T>(
  workspace: string,
  identity: PeerWorkerIdentity,
  ownClaimIds: Set<string>,
  fn: () => Promise<T>,
  options: { signal?: AbortSignal; env?: ClaimsEnvironment; releaseBudgetMs?: number } = {},
): Promise<T> {
  const handle = await acquireWriterClaim(workspace, identity, ownClaimIds, options);
  try {
    return await fn();
  } finally {
    const budget = options.releaseBudgetMs ?? 1_000;
    await handle.release(performance.now() + budget);
  }
}

/**
 * Abortable read-only barrier lookup on a disposable forked `FilesystemClient`.
 * Aborting immediately disposes the fork so blocked RPCs settle without holding exclusive locks.
 */
async function abortableBarrierLookup(
  fs: Pick<Filesystem, "fork">,
  signal?: AbortSignal,
  createClient?: (fs: Pick<Filesystem, "fork">) => { asyncCall(method: string, args: unknown[]): Promise<unknown>; dispose(): void },
): Promise<void> {
  signal?.throwIfAborted();
  const client = createClient ? createClient(fs) : new FilesystemClient(fs.fork());
  const onAbort = () => {
    try { client.dispose(); } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const rootHandle = await client.asyncCall("preopen", ["/"]) as number;
    signal?.throwIfAborted();
    await client.asyncCall("resolve", [rootHandle, ".", true]);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { client.dispose(); } catch {}
  }
}

/**
 * Abortable read-only storage mount readiness probe (`client.asyncCall("resolvePath", ["/"])`).
 * Waffle 0.0.148 returns `{ path: "/", kind: "dir" }` only after storage backend open/attach succeeds.
 */
export async function probeFilesystemReady(
  fs: Pick<Filesystem, "fork" | "ownershipLost" | "state">,
  signal?: AbortSignal,
  createClient?: (fs: Pick<Filesystem, "fork">) => {
    asyncCall(method: string, args: unknown[]): Promise<unknown>;
    dispose(): void;
  },
): Promise<void> {
  signal?.throwIfAborted();
  const initialStatus: string = fs.state.status;
  if (fs.ownershipLost || initialStatus === "failed" || initialStatus === "disposed") {
    throw new Error(`Filesystem is not ready (${fs.ownershipLost ? "ownershipLost" : initialStatus})`);
  }
  const client = createClient ? createClient(fs) : new FilesystemClient(fs.fork());
  const onAbort = () => {
    try { client.dispose(); } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const resolved = await client.asyncCall("resolvePath", ["/"]) as { kind?: string } | undefined;
    signal?.throwIfAborted();
    if (!resolved || resolved.kind !== "dir") {
      throw new Error("Filesystem root probe did not resolve a directory");
    }
    const postStatus: string = fs.state.status;
    if (fs.ownershipLost || postStatus === "failed" || postStatus === "disposed") {
      throw new Error(`Filesystem failed during readiness probe (${fs.ownershipLost ? "ownershipLost" : postStatus})`);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { client.dispose(); } catch {}
  }
}

/**
 * Fences any crashed peer writer whose `claimLock` and `pageAliveLock` are both gone by
 * waiting FIFO on its `peerAliveLock`, issuing an abortable barrier lookup, and removing the stale claim.
 */
export async function fenceDeadWriters(
  workspace: string,
  fs: Pick<Filesystem, "fork">,
  ownClaimIds: ReadonlySet<string>,
  options: {
    signal?: AbortSignal;
    env?: ClaimsEnvironment;
    createClient?: (fs: Pick<Filesystem, "fork">) => { asyncCall(method: string, args: unknown[]): Promise<unknown>; dispose(): void };
  } = {},
): Promise<void> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const locks = options.env?.locks ?? navigator.locks;
  const store = options.env?.store ?? sharedClaimsStore();

  const claims = await raceAbort(store.listWriterClaims(workspace), signal);
  signal?.throwIfAborted();
  if (claims.length === 0) return;

  const snapshot = await raceAbort(locks.query(), signal);
  signal?.throwIfAborted();
  const heldNames = new Set((snapshot.held ?? []).map((h) => h.name).filter((n): n is string => typeof n === "string"));

  for (const claim of claims) {
    signal?.throwIfAborted();
    if (ownClaimIds.has(claim.claimLock) || heldNames.has(claim.claimLock)) continue;
    if (heldNames.has(claim.pageAliveLock)) {
      await raceAbort(store.removeWriterClaim(workspace, claim.claimLock), signal);
      continue;
    }
    // Dead peer: fence its worker peerAliveLock FIFO, then barrier-lookup, then remove claim.
    const fence = await acquireLockHandle(claim.peerAliveLock, { mode: "exclusive", signal, locks });
    fence?.release();
    signal?.throwIfAborted();
    await abortableBarrierLookup(fs, signal, options.createClient);
    signal?.throwIfAborted();
    await raceAbort(store.removeWriterClaim(workspace, claim.claimLock), signal);
  }
}

export function trackUnsettledPromise(
  promise: Promise<void>,
  unsettled: Set<Promise<void>>,
  failures: unknown[],
): Promise<void> {
  unsettled.add(promise);
  void promise.then(
    () => { unsettled.delete(promise); },
    (err) => {
      unsettled.delete(promise);
      failures.push(err);
    },
  );
  return promise;
}

export async function verifyWorkerLocksReleased(
  identity: PartialWorkerIdentity | null,
  locks: LockManagerLike | undefined = typeof navigator !== "undefined" ? navigator.locks : undefined,
): Promise<boolean> {
  if (!identity?.workerClientId || !locks) return false;
  try {
    const snap = await locks.query();
    const held = snap.held ?? [];
    const hasWorkerLock = held.some((h) => h.clientId === identity.workerClientId);
    const hasPeerLock = identity.peerAliveLock ? held.some((h) => h.name === identity.peerAliveLock) : false;
    return !hasWorkerLock && !hasPeerLock;
  } catch {
    return false;
  }
}

/** In-memory Web Locks implementation for deterministic multi-tab unit tests. */
export class MemoryLockManager implements LockManagerLike {
  private readonly held = new Map<string, Array<{ mode: "exclusive" | "shared"; clientId: string }>>();
  private readonly queues = new Map<string, Array<() => void>>();

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => Promise<T> | T),
    maybeCallback?: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    const options: LockOptions = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const cb = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback)!;
    const mode = options.mode ?? "exclusive";

    const canAcquire = () => {
      const current = this.held.get(name) ?? [];
      return current.length === 0 || (mode === "shared" && current.every((h) => h.mode === "shared"));
    };

    const runWith = async (): Promise<T> => {
      const list = this.held.get(name) ?? [];
      const entry = { mode, clientId: "memory-lock-client" };
      list.push(entry);
      this.held.set(name, list);
      try {
        return await cb({ name, mode } as Lock);
      } finally {
        const cur = this.held.get(name);
        if (cur) {
          const idx = cur.indexOf(entry);
          if (idx >= 0) cur.splice(idx, 1);
          if (cur.length === 0) this.held.delete(name);
        }
        const q = this.queues.get(name);
        while (q && q.length > 0 && canAcquire()) q.shift()!();
      }
    };

    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    if (canAcquire()) return runWith();
    if (options.ifAvailable) return Promise.resolve(cb(null));

    return new Promise<T>((resolve, reject) => {
      const q = this.queues.get(name) ?? [];
      const wake = () => {
        options.signal?.removeEventListener("abort", onAbort);
        void runWith().then(resolve, reject);
      };
      const onAbort = () => {
        const idx = q.indexOf(wake);
        if (idx >= 0) q.splice(idx, 1);
        reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      q.push(wake);
      this.queues.set(name, q);
    });
  }

  async query(): Promise<LockManagerSnapshot> {
    const held: LockInfo[] = [];
    for (const [name, entries] of this.held) {
      for (const e of entries) held.push({ name, mode: e.mode, clientId: e.clientId });
    }
    return { held, pending: [] };
  }
}
