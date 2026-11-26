import { expect, test } from "bun:test";
import { MemoryBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import { createFilesystemConnection } from "waffle/fs/protocol";
import {
  DevServerCoordinator,
  type CoordinatorHost,
  type CoordinatorWorkspace,
  type RetireOptions,
  type RetireResult,
} from "../sandbox/src/dev-server-coordinator";
import { MemoryClaimsStore, MemoryLockManager } from "../web/src/workspace-claims";

const TestLockManager = MemoryLockManager;

class TestBroadcastHub {
  private readonly channels = new Set<TestBroadcastChannel>();
  suppress = false;
  register(ch: TestBroadcastChannel) { this.channels.add(ch); }
  unregister(ch: TestBroadcastChannel) { this.channels.delete(ch); }
  dispatch(from: TestBroadcastChannel, data: unknown) {
    if (this.suppress) return;
    for (const ch of this.channels) {
      if (ch !== from && ch.name === from.name && !ch.closed) {
        queueMicrotask(() => {
          if (!ch.closed) ch.onmessage?.({ data } as MessageEvent);
        });
      }
    }
  }
}

class TestBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(readonly name: string, private readonly hub: TestBroadcastHub) {
    hub.register(this);
  }
  postMessage(data: unknown) {
    if (this.closed) throw new DOMException("Channel closed", "InvalidStateError");
    this.hub.dispatch(this, data);
  }
  close() {
    this.closed = true;
    this.hub.unregister(this);
  }
}

interface TabHarness {
  tabId: string;
  coordinator: DevServerCoordinator;
  workspace: CoordinatorWorkspace | null;
  reloaded: boolean;
  reopenedCount: number;
  retiredCount: number;
  /** The `stopReason` of every retirement that began. */
  stopReasons: string[];
  launches: number;
  devActive: boolean;
  reports: string[];
  roles: Array<"owner" | "follower">;
  failNextResetMutation: boolean;
  failNextRetire: boolean;
}

function makeWorkspace(tabId: string, gen: number): CoordinatorWorkspace {
  const backend = new MemoryBackend();
  const services: FilesystemService[] = [];
  const ports: MessagePort[] = [];
  const runtime = {
    disposed: false,
    async dispose() {
      runtime.disposed = true;
      for (const s of services) s.dispose();
      for (const p of ports) p.close();
    },
  };
  return {
    runtime: runtime as never,
    fs: {
      ownershipLost: false,
      state: { status: "ready" as const },
      fork() {
        const service = new FilesystemService(backend);
        const conn = createFilesystemConnection();
        services.push(service);
        ports.push(conn.client.port, conn.server.port);
        service.connect(conn.server);
        return conn.client;
      },
      async mkdirp() {},
      async flush() {},
    } as never,
    launchInvalidated: false,
    getIdentity: () => ({
      tabId,
      pageAliveLock: `bun-wasm:workspace:page-alive:ws:${tabId}`,
      workerInstanceId: `${tabId}-w-${gen}`,
      workerClientId: `${tabId}-c-${gen}`,
      peerAliveLock: `waffle:multitab:v1:peer-alive:${tabId}-${gen}`,
    }),
  };
}

function createSharedResetState() {
  return {
    resetGeneration: 0,
    resetInProgress: false,
    resetWrites: 0,
    recoveredCount: 0,
  };
}

function makeTab(
  tabId: string,
  locks: MemoryLockManager,
  hub: TestBroadcastHub,
  store: MemoryClaimsStore,
  sharedReset: ReturnType<typeof createSharedResetState>,
  engine = "browser",
): TabHarness {
  let wsGen = 1;
  const h: TabHarness = {
    tabId,
    coordinator: null as never,
    workspace: makeWorkspace(tabId, wsGen),
    reloaded: false,
    reopenedCount: 0,
    retiredCount: 0,
    stopReasons: [],
    launches: 0,
    devActive: false,
    reports: [],
    roles: [],
    failNextResetMutation: false,
    failNextRetire: false,
  };

  const host: CoordinatorHost = {
    scope: "ws",
    tabId,
    engine,
    ownClaimIds: new Set<string>(),
    stopWaitMs: 500,
    heartbeatMs: 20,
    locks,
    claimsEnv: { locks, store },
    channelFactory: (name: string) => new TestBroadcastChannel(name, hub) as unknown as BroadcastChannel,
    getWorkspace: () => h.workspace,
    isWorkspaceUsable: (ws): ws is CoordinatorWorkspace =>
      ws !== null && !ws.runtime.disposed && !ws.fs.ownershipLost && ws.fs.state.status !== "failed" && ws.fs.state.status !== "disposed" && ws.getIdentity() !== null,
    isDisposed: () => false,
    isTeardownRequested: () => false,
    hasActiveDevLaunchForCurrentWorkspace: () => h.devActive && h.workspace !== null && !h.workspace.launchInvalidated,
    getActiveDevWorkspace: () => (h.devActive ? h.workspace : null),
    hasDevState: () => h.devActive,
    hasRollbackFailure: () => false,
    hasTerminalDisposalFailures: () => false,
    hasUnsettledDisposals: () => false,
    hasProvisionalReopen: () => false,
    hasPendingDevClaim: () => false,
    hasActiveLaunchReservation: () => false,
    hasUncommittedProvisions: () => false,
    hasLifecycleTransition: () => false,
    joinPendingDevClaim: async () => {},
    joinUncommittedProvisions: async () => {},
    joinLifecycleTransition: async () => {},
    waitForOwnResetGateIdle: async () => {},
    async retireRuntime(opts: RetireOptions): Promise<RetireResult> {
      if (h.failNextRetire) {
        h.failNextRetire = false;
        return { ok: false, reason: "other" };
      }
      if (opts.onlyIfUnusable && h.workspace && !h.workspace.runtime.disposed && !h.workspace.launchInvalidated) {
        return { ok: true };
      }
      if (opts.shouldBegin && !opts.shouldBegin()) return { ok: false, reason: "other" };
      h.devActive = false;
      h.retiredCount++;
      h.stopReasons.push(opts.stopReason);
      if (h.workspace) (h.workspace.runtime as any).disposed = true;
      h.workspace = null;
      if (opts.mode === "reopen") {
        if (opts.shouldReopen && !opts.shouldReopen()) return { ok: false, reason: "other" };
        h.workspace = makeWorkspace(tabId, ++wsGen);
        h.reopenedCount++;
      }
      return { ok: true };
    },
    async launchDevServerAdmission(_attemptId, _signal, onCommit) {
      h.devActive = true;
      h.launches++;
      onCommit?.();
    },
    async repairBaseProgramsIfNeeded() {},
    clearOwnedPreview() {},
    getCurrentOwnerState: () => (h.devActive ? { state: "up", text: "localhost:5173/", port: 5173 } : null),
    async readResetState() {
      return { resetGeneration: sharedReset.resetGeneration, resetInProgress: sharedReset.resetInProgress };
    },
    async beginResetTransaction() {
      sharedReset.resetGeneration++;
      sharedReset.resetInProgress = true;
      return sharedReset.resetGeneration;
    },
    async completeResetTransaction() {
      sharedReset.resetInProgress = false;
    },
    async fetchTemplateSources() {
      return { "src/App.tsx": "export default 'reset';" };
    },
    async recoverInterruptedResetMutation(_ws, _sig, beforeFirstMutation) {
      beforeFirstMutation?.();
      sharedReset.recoveredCount++;
    },
    async runCoordinatedResetMutation() {
      if (h.failNextResetMutation) {
        h.failNextResetMutation = false;
        throw new Error("injected reset write failure");
      }
      sharedReset.resetWrites++;
    },
    async trackDurableWrite(fn) { return fn(); },
    async ensureTmpDir() {},
    async onWatchRebind() {},
    onWatchAbort() {},
    async onRefreshAndSync() {},
    onEditorSuspendAutosave() {},
    onEditorResumeAfterReset() {},
    onEditorDiscard() {},
    onResetCommittedReload() { h.reloaded = true; },
    onObservedOwnerState() {},
    onObservedOwnerStopping() {},
    onFrozenOwnerDetected() {},
    onRoleChange(role) { h.roles.push(role); },
    onReport(msg) { h.reports.push(msg); },
  };

  h.coordinator = new DevServerCoordinator(host);
  return h;
}

const wait = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

test("DevServerCoordinator elects exactly one owner, fails over cleanly, and performs targeted cross-engine handover", async () => {
  const locks = new TestLockManager();
  const hub = new TestBroadcastHub();
  const store = new MemoryClaimsStore();
  const sharedReset = createSharedResetState();

  const tab1 = makeTab("tab-1", locks, hub, store, sharedReset, "browser");
  const tab2 = makeTab("tab-2", locks, hub, store, sharedReset, "quickjs");

  await tab1.coordinator.attemptElection();
  await tab2.coordinator.attemptElection();
  tab1.coordinator.broadcastOwnerState("up", "localhost:5173/", 5173);
  await wait(60);

  expect(tab1.coordinator.role).toBe("owner");
  expect(tab2.coordinator.role).toBe("follower");
  expect(tab1.launches).toBe(1);
  expect(tab2.launches).toBe(0);

  // Follower requests handover -> Owner retires and releases ownerLock, Follower promotes and launches!
  const handover = await tab2.coordinator.requestRestartOrHandover();
  expect(handover.ok).toBe(true);
  await wait(80);
  expect(tab1.coordinator.role).toBe("follower");
  expect(tab2.coordinator.role).toBe("owner");
  expect(tab2.launches).toBe(1);

  tab1.coordinator.stop();
  tab2.coordinator.stop();
});

test("Follower-initiated coordinated reset quiesces live Owner, commits reset, and re-elects on peer resume", async () => {
  const locks = new TestLockManager();
  const hub = new TestBroadcastHub();
  const store = new MemoryClaimsStore();
  const sharedReset = createSharedResetState();

  const owner = makeTab("tab-owner", locks, hub, store, sharedReset);
  const follower = makeTab("tab-follower", locks, hub, store, sharedReset);

  await owner.coordinator.attemptElection();
  await follower.coordinator.attemptElection();
  await wait();
  expect(owner.coordinator.role).toBe("owner");
  expect(follower.coordinator.role).toBe("follower");

  // Follower runs coordinated reset while Owner is live!
  await follower.coordinator.resetWorkspace();
  await wait(80);

  expect(follower.reloaded).toBe(true);
  expect(sharedReset.resetWrites).toBe(1);
  expect(sharedReset.resetInProgress).toBe(false);
  expect(sharedReset.resetGeneration).toBe(1);
  // Owner quiesced (retired old runtime) and resumed cleanly with a reopened runtime & re-elected!
  expect(owner.retiredCount).toBeGreaterThanOrEqual(1);
  expect(owner.reopenedCount).toBeGreaterThanOrEqual(1);

  owner.coordinator.stop();
  follower.coordinator.stop();
});

test("an owner's own Reset template stops its command for the reset, not for a restart", async () => {
  const locks = new TestLockManager();
  const hub = new TestBroadcastHub();
  const owner = makeTab("tab-owner", locks, hub, new MemoryClaimsStore(), createSharedResetState());
  await owner.coordinator.attemptElection();
  await wait();
  expect(owner.coordinator.role).toBe("owner");

  await owner.coordinator.resetWorkspace();
  await wait(80);

  expect(owner.stopReasons.length).toBeGreaterThanOrEqual(1);
  expect(new Set(owner.stopReasons)).toEqual(new Set(["resetting the template"]));
  owner.coordinator.stop();
});

test("an automatic restart does nothing once its target ended, even queued behind another restart", async () => {
  const locks = new TestLockManager();
  const hub = new TestBroadcastHub();
  const owner = makeTab("tab-owner", locks, hub, new MemoryClaimsStore(), createSharedResetState());
  await owner.coordinator.attemptElection();
  await wait();
  expect(owner.coordinator.role).toBe("owner");
  const launches = owner.launches;

  expect((await owner.coordinator.restartOwnedDevServer(() => false)).ok).toBe(false);
  expect(owner.retiredCount).toBe(0);
  expect(owner.launches).toBe(launches);

  // Two reconciles for one serving run: the first restart ends that run, so the queued second
  // finds its target gone and must not retire the first restart's new command.
  const target = owner.retiredCount;
  const stillWanted = () => owner.retiredCount === target;
  const [first, second] = await Promise.all([
    owner.coordinator.restartOwnedDevServer(stillWanted),
    owner.coordinator.restartOwnedDevServer(stillWanted),
  ]);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(false);
  expect(owner.retiredCount).toBe(1);
  expect(owner.stopReasons).toEqual(["restarting"]);
  expect(owner.launches).toBe(launches + 1);
  owner.coordinator.stop();
});

test("enterResetGate recovers an interrupted reset transaction durably before granting shared gate", async () => {
  const locks = new TestLockManager();
  const hub = new TestBroadcastHub();
  const store = new MemoryClaimsStore();
  const sharedReset = createSharedResetState();
  sharedReset.resetInProgress = true;
  sharedReset.resetGeneration = 3;

  const survivor = makeTab("tab-survivor", locks, hub, store, sharedReset);
  const lease = await survivor.coordinator.enterResetGate();
  try {
    expect(sharedReset.resetInProgress).toBe(false);
    expect(sharedReset.recoveredCount).toBe(1);
    expect(lease.resetGeneration).toBe(3);
  } finally {
    lease.release();
  }
  survivor.coordinator.stop();
});

test("Reset failure after mutation preserves non-committed recovery without stranding owner leases", async () => {
  const locks = new TestLockManager();
  const hub = new TestBroadcastHub();
  const store = new MemoryClaimsStore();
  const sharedReset = createSharedResetState();

  const tab = makeTab("tab-solo", locks, hub, store, sharedReset);
  await tab.coordinator.attemptElection();
  await wait();
  expect(tab.coordinator.role).toBe("owner");

  tab.failNextResetMutation = true;
  await tab.coordinator.resetWorkspace();
  await wait(80);

  expect(tab.reloaded).toBe(false);
  expect(tab.reports.length).toBeGreaterThanOrEqual(1);
  // Interrupted reset should be recovered on re-entry and tab can re-elect cleanly.
  expect(sharedReset.resetInProgress).toBe(false);

  tab.coordinator.stop();
});
