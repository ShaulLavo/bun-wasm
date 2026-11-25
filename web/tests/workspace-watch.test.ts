import { expect, test } from "bun:test";
import type { WatchBatch } from "waffle/fs/watch";
import { startWorkspaceWatch, type FilesystemClientLike, type ReconcileReason } from "../src/workspace-watch";

interface MockWatchControl {
  push(batch: WatchBatch): void;
  fail(err: unknown): void;
  closed: boolean;
}

class MockClient implements FilesystemClientLike {
  readonly retained = new Set<number>();
  readonly released: number[] = [];
  disposed = false;
  watchCalls = 0;
  readonly watches: MockWatchControl[] = [];
  private nextNode = 10;
  private readonly inodes = new Map<string, bigint>();
  private readonly nodeToIno = new Map<number, bigint>();
  blockWatchOpen?: Promise<void>;
  watchOpenPending = false;
  watchOpenAborted = false;

  constructor(initialInodes: Record<string, bigint> = { "": 1n, "home/user/app": 100n }) {
    for (const [k, v] of Object.entries(initialInodes)) this.inodes.set(k, v);
  }

  setInode(relPath: string, ino: bigint | null): void {
    if (ino === null) this.inodes.delete(relPath);
    else this.inodes.set(relPath, ino);
  }

  async asyncCall(method: string, args: unknown[]): Promise<any> {
    if (this.disposed) throw new Error("Client disposed");
    if (method === "preopen") {
      return 1;
    }
    if (method === "resolve") {
      const [, relPath] = args as [number, string, boolean];
      const key = relPath === "." ? "" : relPath;
      const ino = this.inodes.get(key);
      if (ino === undefined) throw Object.assign(new Error(`ENOENT ${relPath}`), { errno: 44 });
      const node = ++this.nextNode;
      this.nodeToIno.set(node, ino);
      return { node, ino };
    }
    if (method === "stat") {
      const [node] = args as [number];
      const ino = this.nodeToIno.get(node);
      if (ino === undefined) throw new Error("EBADF");
      return { ino };
    }
    if (method === "resolvePath") {
      const [path] = args as [string];
      const key = path.replace(/^\/+|\/+$/g, "");
      const ino = this.inodes.get(key);
      if (ino === undefined) return undefined;
      return { path, kind: "dir", ino };
    }
    throw new Error(`Unexpected method ${method}`);
  }

  retain(node: number): void {
    this.retained.add(node);
  }

  release(node: number): void {
    this.retained.delete(node);
    this.released.push(node);
  }

  async watch(_handle: number, options?: { recursive?: boolean; signal?: AbortSignal }) {
    this.watchCalls++;
    if (this.blockWatchOpen) {
      this.watchOpenPending = true;
      await Promise.race([
        this.blockWatchOpen,
        new Promise<void>((_, reject) => {
          const abort = () => {
            this.watchOpenAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      this.watchOpenPending = false;
    }
    if (this.disposed) throw new Error("Client disposed");
    const queue: Array<{ ok: true; batch: WatchBatch } | { ok: false; err: unknown }> = [];
    let waiter: ((item: { ok: true; batch: WatchBatch } | { ok: false; err: unknown }) => void) | null = null;
    const ctrl: MockWatchControl = {
      closed: false,
      push(batch) {
        const item = { ok: true as const, batch };
        if (waiter) { const w = waiter; waiter = null; w(item); } else queue.push(item);
      },
      fail(err) {
        const item = { ok: false as const, err };
        if (waiter) { const w = waiter; waiter = null; w(item); } else queue.push(item);
      },
    };
    this.watches.push(ctrl);
    return {
      async next(): Promise<WatchBatch> {
        const item = queue.length > 0
          ? queue.shift()!
          : await new Promise<{ ok: true; batch: WatchBatch } | { ok: false; err: unknown }>((resolve) => {
            waiter = resolve;
          });
        if (!item.ok) throw item.err;
        return item.batch;
      },
      async close() {
        if (ctrl.closed) return;
        ctrl.closed = true;
        ctrl.push({ kind: "closed", events: [] });
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watches) {
      if (!w.closed) { w.closed = true; w.push({ kind: "closed", events: [] }); }
    }
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 25));

test("workspace-watch watches immutable root, coalesces relative paths, and retains/releases handles cleanly", async () => {
  const client = new MockClient();
  const batches: string[][] = [];
  const reconciles: ReconcileReason[] = [];
  const handle = startWorkspaceWatch({
    fs: { fork: () => ({}) as never },
    targetPath: "/home/user/app",
    coalesceMs: 5,
    createClient: () => client,
    onPaths: (paths) => { batches.push([...paths]); },
    onReconcile: (reason) => { reconciles.push(reason); },
  });

  await handle.ready;
  expect(client.watchCalls).toBe(1);
  expect(client.retained.size).toBe(1);

  client.watches[0]!.push({
    kind: "events",
    events: [
      { type: "change", id: 1n, name: "home/user/app/src/App.tsx" },
      { type: "rename", id: 2n, name: "home/user/app/src/New.ts" },
      { type: "change", id: 3n, name: "home/user/other/ignored.ts" },
    ],
  });
  await flush();

  expect(batches).toEqual([["src/App.tsx", "src/New.ts"]]);
  expect(reconciles).toEqual([]);

  handle.stop();
  await flush();
  expect(client.disposed).toBe(true);
  expect(client.retained.size).toBe(0);
});

test("workspace-watch distinguishes same-inode ancestor move from target recreate and handles overflow + recovery", async () => {
  const clients: MockClient[] = [];
  const reconciles: ReconcileReason[] = [];
  const handle = startWorkspaceWatch({
    fs: { fork: () => ({}) as never },
    targetPath: "/home/user/app",
    coalesceMs: 5,
    backoffMs: [5, 10],
    createClient: () => {
      const c = new MockClient({ "": 1n, "home/user/app": 100n });
      clients.push(c);
      return c;
    },
    onPaths: () => {},
    onReconcile: (reason) => { reconciles.push(reason); },
  });

  await handle.ready;
  const c0 = clients[0]!;

  // Same-inode ancestor move-away + move-back -> "ancestor-moved".
  c0.watches[0]!.push({ kind: "events", events: [{ type: "rename", id: 1n, name: "home/user" }] });
  await flush();
  expect(reconciles).toEqual(["ancestor-moved"]);

  // Target replaced with a new inode -> "rebound".
  c0.setInode("home/user/app", 200n);
  c0.watches[0]!.push({ kind: "events", events: [{ type: "rename", id: 2n, name: "home/user/app" }] });
  await flush();
  expect(reconciles).toEqual(["ancestor-moved", "rebound"]);

  // Overflow batch -> "fs-overflow".
  c0.watches[0]!.push({ kind: "overflow", events: [] });
  await flush();
  expect(reconciles).toEqual(["ancestor-moved", "rebound", "fs-overflow"]);

  // Watch error/close on the active post-overflow client -> auto-recovers with a new client and emits "recovered".
  const c1 = clients.at(-1)!;
  c1.watches[0]!.fail(new Error("worker recycled"));
  await new Promise<void>((r) => setTimeout(r, 40));
  expect(clients.length).toBeGreaterThanOrEqual(3);
  expect(reconciles.includes("recovered")).toBe(true);

  await handle.rebind({ reconcile: false });
  handle.stop();
  await flush();
  for (const c of clients) expect(c.disposed).toBe(true);
});

test("workspace-watch abort settles a blocked watchOpen immediately via client.dispose()", async () => {
  const blocked = Promise.withResolvers<void>();
  const client = new MockClient();
  client.blockWatchOpen = blocked.promise;

  const controller = new AbortController();
  const handle = startWorkspaceWatch({
    fs: { fork: () => ({}) as never },
    targetPath: "/home/user/app",
    signal: controller.signal,
    createClient: () => client,
    onPaths: () => {},
    onReconcile: () => {},
  });

  await flush();
  expect(client.watchOpenPending).toBe(true);
  controller.abort();
  await expect(handle.ready).rejects.toThrow(/Abort/i);
  expect(client.disposed).toBe(true);
  blocked.resolve();
});
