import { expect, test } from "bun:test";
import {
  acquireWriterClaim,
  fenceDeadWriters,
  MemoryClaimsStore,
  MemoryLockManager,
  probeFilesystemReady,
  withWriterClaim,
  type PeerWorkerIdentity,
} from "../src/workspace-claims";
import {
  rollbackMarkersDurably,
  upgradeReactRouterPreviewMount,
  withExclusiveLiveWriters,
  withProvisionBinsLock,
  withProvisionSeedLock,
} from "../src/workspace-provision";
import { BrowserPrograms, ProvisionAbortedError, ProvisionRollbackError, type ProvisioningStatus } from "../src/browser-programs";

const FakeLockManager = MemoryLockManager;

function makeFakeFs(initial: Record<string, string | Uint8Array> = {}, opts: { rootKind?: string; failResolvePath?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(initial)) {
    files.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v));
  }
  let flushes = 0;
  let resolvePathCalls = 0;
  const fs = {
    files,
    ownershipLost: false,
    state: { status: "ready" as const },
    get flushes() { return flushes; },
    get resolvePathCalls() { return resolvePathCalls; },
    fork() { return {}; },
    async lookup(path: string) {
      if (files.has(path)) return { kind: "file" };
      if (path === "/" || Array.from(files.keys()).some((k) => k.startsWith(`${path}/`))) return { kind: "dir" };
      return undefined;
    },
    async readFile(path: string) {
      const v = files.get(path);
      if (!v) throw new Error(`ENOENT ${path}`);
      return new Uint8Array(v);
    },
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
    },
    async remove(path: string, options?: { ifContent?: Uint8Array }) {
      const existing = files.get(path);
      if (!existing) return;
      if (options?.ifContent) {
        if (existing.length !== options.ifContent.length || existing.some((b, i) => b !== options.ifContent![i])) return;
      }
      files.delete(path);
    },
    async mkdirp(_path: string) {},
    async flush() { flushes++; },
  };

  const clientFactory = () => ({
    disposed: false,
    async asyncCall(method: string, args: unknown[]) {
      if (method === "preopen") return 1;
      if (method === "resolve") { resolvePathCalls++; return { node: 2, ino: 1n }; }
      if (method === "resolvePath") {
        resolvePathCalls++;
        if (opts.failResolvePath) throw new Error("storage backend mount failed");
        const [path] = args as [string];
        if (path === "/") return { path: "/", kind: opts.rootKind ?? "dir" };
        if (files.has(path)) return { path, kind: "file" };
        return undefined;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
    dispose() {},
  });

  return { fs, clientFactory };
}

test("probeFilesystemReady accepts kind === 'dir' and rejects non-dir or mount failure", async () => {
  const good = makeFakeFs({}, { rootKind: "dir" });
  await expect(probeFilesystemReady(good.fs as never, undefined, good.clientFactory as never)).resolves.toBeUndefined();

  const wrongKind = makeFakeFs({}, { rootKind: "file" });
  await expect(probeFilesystemReady(wrongKind.fs as never, undefined, wrongKind.clientFactory as never)).rejects.toThrow(/resolve a directory/i);

  const failed = makeFakeFs({}, { failResolvePath: true });
  await expect(probeFilesystemReady(failed.fs as never, undefined, failed.clientFactory as never)).rejects.toThrow(/mount failed/);
});

test("writer claims commit before write, fence dead writers on takeover, and skip own claims", async () => {
  const locks = new FakeLockManager();
  const store = new MemoryClaimsStore();
  const env = { locks, store };
  const ownClaimIds = new Set<string>();
  const { fs, clientFactory } = makeFakeFs();

  const deadIdentity: PeerWorkerIdentity = {
    tabId: "dead-tab",
    pageAliveLock: "bun-wasm:workspace:page-alive:ws:dead-tab",
    workerInstanceId: "dead-worker-1",
    workerClientId: "dead-client",
    peerAliveLock: "waffle:multitab:v1:peer-alive:dead-1",
  };
  // Seed a dead claim whose locks are no longer held (simulating a crashed peer).
  await store.addWriterClaim("ws", {
    peerAliveLock: deadIdentity.peerAliveLock,
    claimLock: "bun-wasm:workspace:claim:ws:dead-claim-1",
    pageAliveLock: deadIdentity.pageAliveLock,
  });
  expect((await store.listWriterClaims("ws")).length).toBe(1);

  // Fence dead writers removes the dead claim after barrier lookup.
  await fenceDeadWriters("ws", fs as never, ownClaimIds, { env, createClient: clientFactory as never });
  expect((await store.listWriterClaims("ws")).length).toBe(0);
  expect(fs.resolvePathCalls).toBe(1);

  // Live claim held by another tab is NOT removed until released.
  const liveClaim = await acquireWriterClaim("ws", deadIdentity, new Set(), { env });
  expect((await store.listWriterClaims("ws")).length).toBe(1);
  await fenceDeadWriters("ws", fs as never, ownClaimIds, { env, createClient: clientFactory as never });
  expect((await store.listWriterClaims("ws")).length).toBe(1);
  await liveClaim.release();
  expect((await store.listWriterClaims("ws")).length).toBe(0);

  // Own active claim is cleaned cleanly on release.
  let seenInside = 0;
  await withWriterClaim(
    "ws",
    { ...deadIdentity, tabId: "live-tab" },
    ownClaimIds,
    async () => {
      seenInside = (await store.listWriterClaims("ws")).length;
    },
    { env },
  );
  expect(seenInside).toBe(1);
  expect((await store.listWriterClaims("ws")).length).toBe(0);
});

test("provision locks fence before running and withExclusiveLiveWriters skips when a peer holds shared writers lock", async () => {
  const locks = new FakeLockManager();
  const store = new MemoryClaimsStore();
  const env = { locks, store };
  const ownClaimIds = new Set<string>();
  const { fs, clientFactory } = makeFakeFs();

  let seedRan = false;
  await withProvisionSeedLock("ws", fs as never, ownClaimIds, async () => { seedRan = true; }, { env: { ...env, createClient: clientFactory as never } as never });
  expect(seedRan).toBe(true);

  let binsRan = false;
  await withProvisionBinsLock("ws", fs as never, ownClaimIds, async () => { binsRan = true; }, { env: { ...env, createClient: clientFactory as never } as never });
  expect(binsRan).toBe(true);

  // Hold shared live-writers lock -> withExclusiveLiveWriters must skip cleanly.
  let releasePeer!: () => void;
  const peerHeld = Promise.withResolvers<void>();
  const peerHold = locks.request("bun-wasm:workspace:live-writers:ws", { mode: "shared" }, async () => {
    peerHeld.resolve();
    await new Promise<void>((r) => { releasePeer = r; });
  });
  await peerHeld.promise;

  let exclusiveRan = false;
  const skipped = await withExclusiveLiveWriters("ws", fs as never, ownClaimIds, async () => {
    exclusiveRan = true;
    return "mutated";
  }, { env });
  expect(skipped.skipped).toBe(true);
  expect(exclusiveRan).toBe(false);

  releasePeer();
  await peerHold;

  const ran = await withExclusiveLiveWriters("ws", fs as never, ownClaimIds, async () => {
    exclusiveRan = true;
    return "mutated";
  }, { env });
  expect(ran).toEqual({ skipped: false, value: "mutated" });
  expect(exclusiveRan).toBe(true);
});

test("upgradeReactRouterPreviewMount widens legacy regex idempotently", async () => {
  const oldSrc = `const PREVIEW_MOUNT = /^\\/(?:[^/?#\\\\]+\\/)*__preview\\/([1-9]\\d{0,4})\\/$/;`;
  const { fs } = makeFakeFs({ "/home/user/app/app/preview-context.ts": oldSrc });
  expect(await upgradeReactRouterPreviewMount(fs as never, "/home/user/app")).toBe(true);
  const upgraded = new TextDecoder().decode(await fs.readFile("/home/user/app/app/preview-context.ts"));
  expect(upgraded).toContain("(?:r\\/(?:ws|mem|pg)-");
  expect(await upgradeReactRouterPreviewMount(fs as never, "/home/user/app")).toBe(false);
});

test("rollbackMarkersDurably settles all removals via Promise.allSettled and flushes", async () => {
  const { fs } = makeFakeFs({
    "/bin/a": new Uint8Array([1, 2, 3]),
    "/bin/b": new Uint8Array([9, 9, 9]),
    "/bin/c": new Uint8Array([1, 2, 3]),
  });
  const marker = new Uint8Array([1, 2, 3]);
  await rollbackMarkersDurably(fs as never, ["/bin/a", "/bin/b", "/bin/c"], marker);
  expect(fs.files.has("/bin/a")).toBe(false);
  // /bin/b had different bytes so atomic ifContent preserved it!
  expect(fs.files.has("/bin/b")).toBe(true);
  expect(fs.files.has("/bin/c")).toBe(false);
  expect(fs.flushes).toBe(1);
});

test("BrowserPrograms commits base marker, aborts cleanly with rollback, and surfaces ProvisionRollbackError on rollback failure", async () => {
  const states: ProvisioningStatus[] = [];
  const { fs } = makeFakeFs();
  const fakeRuntime = {
    disposed: false,
    filesystem: fs,
    registerAdapter: () => () => {},
    registerHostAdapter: () => () => {},
    registerProgram: () => () => {},
  };
  const urls = {
    worker: new URL("https://example.test/preview1-worker.js"),
    shell: new URL("https://example.test/shell-engine.wasm"),
    shellWorker: new URL("https://example.test/shell-worker.js"),
  };

  // Pre-aborted transaction throws ProvisionAbortedError before committing.
  const bpAborted = new BrowserPrograms(fakeRuntime as never, urls, {
    onStateChange: (s) => states.push(s),
    runTransaction: async (fn) => {
      const ctrl = new AbortController();
      ctrl.abort();
      return fn(ctrl.signal);
    },
  });
  await expect(bpAborted.ready()).rejects.toBeInstanceOf(ProvisionAbortedError);
  expect(fs.files.has("/usr/local/bin/.bunwasm-base-provisioned")).toBe(false);
  expect(states).toContain("idle");
  expect(new ProvisionRollbackError([new Error("io")]).name).toBe("ProvisionRollbackError");
});
