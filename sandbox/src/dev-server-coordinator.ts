import type { Runtime } from "waffle";
import {
  acquireLockHandle,
  acquireWriterClaim,
  fenceDeadWriters,
  probeFilesystemReady,
  raceAbort,
  withWriterClaim,
  type ClaimsEnvironment,
  type PeerWorkerIdentity,
  type WriterClaimHandle,
} from "../../web/src/workspace-claims";
import type { ResetState } from "./workspace-index";
import type { TemplateSources } from "./template";

export class ResetInProgressError extends Error {
  constructor(message = "Workspace reset is in progress") {
    super(message);
    this.name = "ResetInProgressError";
  }
}

class ResetYieldError extends Error {
  constructor(message = "Yielded to a competing workspace reset") {
    super(message);
    this.name = "ResetYieldError";
  }
}

class ResetAbortedError extends Error {
  constructor(message = "Workspace reset was aborted before mutation") {
    super(message);
    this.name = "ResetAbortedError";
  }
}

export class LaunchCancelledError extends Error {
  constructor(message = "Dev server launch was cancelled") {
    super(message);
    this.name = "LaunchCancelledError";
  }
}

class ElectionCancelledError extends Error {
  constructor(message = "Owner election was cancelled") {
    super(message);
    this.name = "ElectionCancelledError";
  }
}

export class ResetGenerationMismatchError extends Error {
  constructor(message = "Document was edited against a previous reset generation") {
    super(message);
    this.name = "ResetGenerationMismatchError";
  }
}

export type RetireResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "pending-settlement"; readonly pending: Promise<unknown> }
  | { readonly ok: false; readonly reason: "other" };

export interface RetireOptions {
  readonly mode: "teardown" | "retire-only" | "reopen";
  readonly onlyIfUnusable?: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly shouldBegin?: () => boolean;
  readonly confirmBegin?: (signal?: AbortSignal) => Promise<boolean>;
  readonly shouldReopen?: () => boolean;
}

export interface ResetGateLease {
  readonly resetGeneration: number;
  release(): void;
}

export interface CoordinatorWorkspace {
  readonly runtime: Pick<Runtime, "disposed" | "dispose">;
  readonly fs: Runtime["filesystem"];
  launchInvalidated: boolean;
  getIdentity(): PeerWorkerIdentity | null;
}

export interface OwnerBroadcastState {
  readonly state: "starting" | "up" | "down";
  readonly text: string;
  readonly port?: number;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly engine: string;
}

export interface CoordinatorHost {
  readonly scope: string;
  readonly tabId: string;
  readonly engine: string;
  readonly ownClaimIds: Set<string>;
  readonly stopWaitMs?: number;
  readonly heartbeatMs?: number;
  readonly silentThresholdMs?: number;
  readonly locks?: Pick<LockManager, "request" | "query">;
  readonly channelFactory?: (name: string) => BroadcastChannel;
  readonly claimsEnv?: ClaimsEnvironment;

  getWorkspace(): CoordinatorWorkspace | null;
  isWorkspaceUsable(ws: CoordinatorWorkspace | null): ws is CoordinatorWorkspace;
  isDisposed(): boolean;
  isTeardownRequested(): boolean;
  hasActiveDevLaunchForCurrentWorkspace(): boolean;
  getActiveDevWorkspace(): CoordinatorWorkspace | null;
  hasDevState(): boolean;
  hasRollbackFailure(): boolean;
  hasTerminalDisposalFailures(): boolean;
  hasUnsettledDisposals(): boolean;
  hasProvisionalReopen(): boolean;
  hasPendingDevClaim(): boolean;
  hasActiveLaunchReservation(): boolean;
  hasUncommittedProvisions(): boolean;
  hasLifecycleTransition(): boolean;

  joinPendingDevClaim(signal?: AbortSignal): Promise<void>;
  joinUncommittedProvisions(signal?: AbortSignal): Promise<void>;
  joinLifecycleTransition(signal?: AbortSignal): Promise<void>;
  waitForOwnResetGateIdle(): Promise<void>;

  retireRuntime(options: RetireOptions): Promise<RetireResult>;
  launchDevServerAdmission(
    attemptId: string,
    signal?: AbortSignal,
    onCommit?: () => void,
  ): Promise<void>;
  repairBaseProgramsIfNeeded(signal?: AbortSignal): Promise<void>;
  clearOwnedPreview(): void;
  getCurrentOwnerState(): Omit<OwnerBroadcastState, "ownerId" | "attemptId" | "generation" | "engine"> | null;

  readResetState(): Promise<ResetState>;
  beginResetTransaction(): Promise<number>;
  completeResetTransaction(): Promise<void>;
  fetchTemplateSources(signal?: AbortSignal): Promise<TemplateSources>;
  recoverInterruptedResetMutation(
    ws: CoordinatorWorkspace,
    signal?: AbortSignal,
    beforeFirstMutation?: () => void,
  ): Promise<void>;
  runCoordinatedResetMutation(ws: CoordinatorWorkspace, files: TemplateSources): Promise<void>;
  trackDurableWrite<T>(fn: () => Promise<T>): Promise<T>;
  ensureTmpDir(ws: CoordinatorWorkspace, lease: ResetGateLease, signal?: AbortSignal): Promise<void>;

  onWatchRebind(options?: { reconcile?: boolean; signal?: AbortSignal }): Promise<void>;
  onWatchAbort(): void;
  onRefreshAndSync(lease: ResetGateLease, signal?: AbortSignal): Promise<void>;
  onEditorSuspendAutosave(): void;
  onEditorResumeAfterReset(): void;
  onEditorDiscard(): void;
  onResetCommittedReload(): void;
  onObservedOwnerState(state: OwnerBroadcastState): void;
  onObservedOwnerStopping(ownerId: string, attemptId: string, reason: string): void;
  onFrozenOwnerDetected(): void;
  onRoleChange(role: "owner" | "follower"): void;
  onReport(message: string, error?: unknown): void;
}

type CoordinatorMessage =
  | { type: "heartbeat"; ownerId: string; attemptId: string; generation: number; engine: string; server?: { state: "starting" | "up" | "down"; text: string; port?: number } }
  | { type: "owner-state"; ownerId: string; attemptId: string; generation: number; engine: string; state: "starting" | "up" | "down"; text: string; port?: number }
  | { type: "owner-stopping"; ownerId: string; attemptId: string; reason: "reset" | "close" | "handover" }
  | { type: "ping"; from: string }
  | { type: "reset-begin"; resetId: string; from: string }
  | { type: "reset-end"; resetId: string; from: string }
  | { type: "restart-request"; requestId: string; handoverId?: string; targetOwnerId: string; targetAttemptId: string; engine: string; from: string }
  | { type: "restart-ack"; requestId: string; accepted: boolean; handover?: boolean; error?: string; from: string };

export function coordinatorLocks(scope: string) {
  return {
    resetGate: `bun-wasm:reset-gate:${scope}`,
    resetPendingPrefix: `bun-wasm:reset-pending:${scope}:`,
    resetPending: (id: string) => `bun-wasm:reset-pending:${scope}:${id}`,
    electionArb: `bun-wasm:election-arb:${scope}`,
    handover: `bun-wasm:handover:${scope}`,
    handoverRequest: (id: string) => `bun-wasm:handover-req:${scope}:${id}`,
    alive: (attemptId: string) => `bun-wasm:owner-alive:${scope}:${attemptId}`,
    owner: `bun-wasm:dev-owner:${scope}`,
    channel: `bun-wasm:dev-coordinator:${scope}`,
  };
}

export class DevServerCoordinator {
  role: "follower" | "owner" = "follower";
  currentAttemptId: string | null = null;
  currentResetGeneration = 0;

  ownResetId: string | null = null;
  ownResetPublished = false;
  ownResetMutationStarted = false;
  resetInFlight = false;
  readonly peerResetIds = new Set<string>();
  readonly completedResetIds = new Set<string>();

  ownerLockRelease: (() => void) | null = null;
  aliveLockRelease: (() => void) | null = null;
  ownerResetGateLease: ResetGateLease | null = null;
  private handoverLockRelease: (() => void) | null = null;

  electionAttempt: { controller: AbortController; promise: Promise<void> } | null = null;
  restartLaunchController: AbortController | null = null;
  activeHandover: { controller: AbortController; promise: Promise<void> } | null = null;
  ownerRecovery: { controller: AbortController; promise: Promise<void> } | null = null;
  handoverWatcherController: AbortController | null = null;
  busyOwnerWatcherController: AbortController | null = null;
  peerResumeController: AbortController | null = null;
  resetCancelController: AbortController | null = null;
  peerQuiescePromise: Promise<void> | null = null;

  observedOwner: { ownerId: string; attemptId: string; engine: string; generation: number; lastSeen: number } | null = null;
  private observedAliveWatcherController: AbortController | null = null;
  private ownerGeneration = 0;
  private ownerActionQueue: Promise<void> = Promise.resolve();
  private resetStateChain: Promise<void> = Promise.resolve();
  private readonly pendingRestartAcks = new Map<string, ReturnType<typeof Promise.withResolvers<{ accepted: boolean; handover?: boolean; error?: string }>>>();
  private readonly armedResetWatchers = new Set<string>();
  private readonly lockNames: ReturnType<typeof coordinatorLocks>;
  private readonly locks: Pick<LockManager, "request" | "query">;
  private readonly channel: BroadcastChannel;
  private readonly stopWaitMs: number;
  private readonly heartbeatMs: number;
  private readonly silentThresholdMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly host: CoordinatorHost) {
    this.lockNames = coordinatorLocks(host.scope);
    this.locks = host.locks ?? navigator.locks;
    this.stopWaitMs = host.stopWaitMs ?? 30_000;
    this.heartbeatMs = host.heartbeatMs ?? 1_000;
    this.silentThresholdMs = host.silentThresholdMs ?? 3_500;
    this.channel = (host.channelFactory ?? ((name) => new BroadcastChannel(name)))(this.lockNames.channel);
    this.channel.onmessage = (event: MessageEvent<unknown>) => {
      this.onMessage(event.data as CoordinatorMessage);
    };
  }

  get disposed(): boolean {
    return this.stopped || this.host.isDisposed();
  }

  hasActiveResetIntent(): boolean {
    return this.ownResetId !== null || this.peerResetIds.size > 0;
  }

  hasOwnerState(): boolean {
    return (
      this.role === "owner" ||
      this.ownerResetGateLease !== null ||
      this.ownerLockRelease !== null ||
      this.aliveLockRelease !== null ||
      this.host.hasDevState()
    );
  }

  start(): void {
    if (this.stopped || this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.disposed) return;
      if (this.role === "owner" && this.currentAttemptId) {
        this.broadcastHeartbeat();
        void this.syncPendingResetLocks().catch(() => {});
      } else {
        this.checkSilentOwner();
      }
    }, this.heartbeatMs);
    this.broadcast({ type: "ping", from: this.host.tabId });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.abortAllAsyncActivities();
    for (const pending of this.pendingRestartAcks.values()) {
      pending.resolve({ accepted: false, error: "Coordinator stopped" });
    }
    this.pendingRestartAcks.clear();
    this.channel.onmessage = null;
    try { this.channel.close(); } catch {}
  }

  abortAllAsyncActivities(): void {
    this.electionAttempt?.controller.abort();
    this.restartLaunchController?.abort();
    this.activeHandover?.controller.abort();
    this.ownerRecovery?.controller.abort();
    this.handoverWatcherController?.abort();
    this.busyOwnerWatcherController?.abort();
    this.observedAliveWatcherController?.abort();
    this.peerResumeController?.abort();
    this.resetCancelController?.abort();
  }

  releaseOwnerLeasesInOrder(): void {
    const ownerRel = this.ownerLockRelease;
    const aliveRel = this.aliveLockRelease;
    const gateRel = this.ownerResetGateLease;
    const handoverRel = this.handoverLockRelease;
    this.ownerLockRelease = null;
    this.aliveLockRelease = null;
    this.ownerResetGateLease = null;
    this.handoverLockRelease = null;
    try { ownerRel?.(); } finally {
      try { aliveRel?.(); } finally {
        try { gateRel?.release(); } finally {
          handoverRel?.();
        }
      }
    }
  }

  broadcastOwnerState(state: "starting" | "up" | "down", text: string, port?: number): void {
    if (this.role !== "owner" || !this.currentAttemptId || this.disposed) return;
    this.ownerGeneration++;
    this.broadcast({
      type: "owner-state",
      ownerId: this.host.tabId,
      attemptId: this.currentAttemptId,
      generation: this.ownerGeneration,
      engine: this.host.engine,
      state,
      text,
      port,
    });
  }

  broadcastOwnerStopping(reason: "reset" | "close" | "handover"): void {
    if (!this.currentAttemptId) return;
    this.broadcast({
      type: "owner-stopping",
      ownerId: this.host.tabId,
      attemptId: this.currentAttemptId,
      reason,
    });
  }

  private broadcast(message: CoordinatorMessage): void {
    try {
      this.channel.postMessage(message);
    } catch {
      // Closed channel during teardown is harmless.
    }
  }

  private broadcastHeartbeat(): void {
    if (this.role !== "owner" || !this.currentAttemptId) return;
    const server = this.host.getCurrentOwnerState() ?? undefined;
    this.broadcast({
      type: "heartbeat",
      ownerId: this.host.tabId,
      attemptId: this.currentAttemptId,
      generation: this.ownerGeneration,
      engine: this.host.engine,
      server,
    });
  }

  private onMessage(msg: CoordinatorMessage): void {
    if (!msg || typeof msg !== "object" || this.disposed) return;
    switch (msg.type) {
      case "ping":
        if (this.role === "owner" && this.currentAttemptId) this.broadcastHeartbeat();
        return;
      case "heartbeat":
      case "owner-state":
        if (msg.ownerId === this.host.tabId) return;
        void this.handleObservedOwnerMessage(msg);
        return;
      case "owner-stopping":
        if (msg.ownerId === this.host.tabId) return;
        if (this.observedOwner?.ownerId === msg.ownerId && this.observedOwner.attemptId === msg.attemptId) {
          this.host.onObservedOwnerStopping(msg.ownerId, msg.attemptId, msg.reason);
        }
        return;
      case "reset-begin":
        if (msg.resetId === this.ownResetId) return;
        if (this.ownResetId !== null) {
          // Broadcast is a discovery prompt only, never unverified cancellation authority.
          void this.syncPendingResetLocks().catch(() => {});
        } else {
          this.recordResetIntent(msg.resetId, { lockConfirmed: false });
        }
        return;
      case "reset-end":
        if (msg.resetId !== this.ownResetId) {
          void this.syncPendingResetLocks().catch(() => {});
        }
        return;
      case "restart-request":
        if (msg.from === this.host.tabId) return;
        this.handleRestartRequest(msg);
        return;
      case "restart-ack": {
        const waiter = this.pendingRestartAcks.get(msg.requestId);
        if (waiter) {
          this.pendingRestartAcks.delete(msg.requestId);
          waiter.resolve({ accepted: msg.accepted, handover: msg.handover, error: msg.error });
        }
        return;
      }
    }
  }

  private isOwnerRole(): boolean {
    return this.role === "owner";
  }

  private async handleObservedOwnerMessage(
    msg: Extract<CoordinatorMessage, { type: "heartbeat" | "owner-state" }>,
  ): Promise<void> {
    if (this.disposed || this.isOwnerRole()) return;
    // Verify the sender's attempt lock is actually held before mirroring.
    try {
      const snap = await this.locks.query();
      if (this.disposed || this.isOwnerRole()) return;
      const aliveHeld = (snap.held ?? []).some(
        (h) => h.name === this.lockNames.alive(msg.attemptId) && h.mode === "exclusive",
      );
      if (!aliveHeld) return;
    } catch {
      return;
    }

    const tupleChanged =
      !this.observedOwner ||
      this.observedOwner.ownerId !== msg.ownerId ||
      this.observedOwner.attemptId !== msg.attemptId;
    this.observedOwner = {
      ownerId: msg.ownerId,
      attemptId: msg.attemptId,
      engine: msg.engine,
      generation: msg.generation,
      lastSeen: performance.now(),
    };
    if (tupleChanged) {
      this.armObservedAliveWatcher(msg.attemptId);
    }
    const server = msg.type === "owner-state"
      ? { state: msg.state, text: msg.text, port: msg.port }
      : msg.server;
    if (server) {
      this.host.onObservedOwnerState({
        ownerId: msg.ownerId,
        attemptId: msg.attemptId,
        generation: msg.generation,
        engine: msg.engine,
        state: server.state,
        text: server.text,
        port: server.port,
      });
    }
  }

  private armObservedAliveWatcher(attemptId: string): void {
    this.observedAliveWatcherController?.abort();
    const controller = new AbortController();
    this.observedAliveWatcherController = controller;
    void this.locks
      .request(this.lockNames.alive(attemptId), { mode: "shared", signal: controller.signal }, () => {})
      .then(() => {
        if (controller.signal.aborted || this.disposed) return;
        if (this.observedOwner?.attemptId === attemptId) {
          this.observedOwner = null;
        }
        if (this.role === "follower" && !this.hasActiveResetIntent()) {
          void this.attemptElection();
        }
      })
      .catch(() => {});
  }

  private checkSilentOwner(): void {
    if (this.role !== "follower" || this.disposed || this.hasActiveResetIntent()) return;
    if (!this.observedOwner) {
      this.broadcast({ type: "ping", from: this.host.tabId });
      return;
    }
    const elapsed = performance.now() - this.observedOwner.lastSeen;
    if (elapsed < this.silentThresholdMs) return;
    this.broadcast({ type: "ping", from: this.host.tabId });
    void this.locks.query().then((snap) => {
      if (this.disposed || this.role !== "follower" || this.hasActiveResetIntent()) return;
      const ownerHeld = (snap.held ?? []).some((h) => h.name === this.lockNames.owner && h.mode === "exclusive");
      if (!ownerHeld) {
        this.observedOwner = null;
        void this.attemptElection();
      } else {
        this.host.onFrozenOwnerDetected();
      }
    }).catch(() => {});
  }

  async discoverExclusiveResetIds(signal?: AbortSignal): Promise<string[]> {
    const snap = await raceAbort(this.locks.query(), signal);
    const ids: string[] = [];
    for (const held of snap.held ?? []) {
      if (held.mode === "exclusive" && held.name?.startsWith(this.lockNames.resetPendingPrefix)) {
        const id = held.name.slice(this.lockNames.resetPendingPrefix.length);
        if (id) ids.push(id);
      }
    }
    return ids;
  }

  async syncPendingResetLocks(signal?: AbortSignal): Promise<boolean> {
    const ids = await this.discoverExclusiveResetIds(signal);
    if (signal?.aborted || this.disposed) return ids.length > 0;
    for (const id of ids) {
      if (id !== this.ownResetId) {
        this.recordResetIntent(id, { lockConfirmed: true });
      }
    }
    return ids.length > 0 || this.hasActiveResetIntent();
  }

  private markCompletedResetId(resetId: string): void {
    this.completedResetIds.delete(resetId);
    this.completedResetIds.add(resetId);
    if (this.completedResetIds.size > 128) {
      const oldest = this.completedResetIds.values().next().value;
      if (oldest !== undefined) this.completedResetIds.delete(oldest);
    }
  }

  recordResetIntent(resetId: string, options: { lockConfirmed: boolean }): void {
    if (resetId === this.ownResetId || this.disposed) return;
    if (this.completedResetIds.has(resetId)) return;
    const isNew = !this.peerResetIds.has(resetId);
    if (isNew) {
      this.peerResetIds.add(resetId);
      this.armResetReleaseWatcher(resetId);
    }
    if (this.ownResetId !== null) {
      if (!options.lockConfirmed) return;
      if (!this.ownResetPublished) {
        this.resetCancelController?.abort(new ResetYieldError());
      } else if (!this.ownResetMutationStarted && resetId < this.ownResetId) {
        this.resetCancelController?.abort(new ResetYieldError());
      }
      return;
    }
    this.electionAttempt?.controller.abort();
    this.restartLaunchController?.abort();
    this.activeHandover?.controller.abort();
    this.ownerRecovery?.controller.abort();
    this.handoverWatcherController?.abort();
    this.peerResumeController?.abort();
    this.host.onEditorSuspendAutosave();
    this.enqueueResetState(() => this.quiesceForReset());
  }

  private armResetReleaseWatcher(resetId: string): void {
    if (this.armedResetWatchers.has(resetId)) return;
    this.armedResetWatchers.add(resetId);
    void this.locks
      .request(this.lockNames.resetPending(resetId), { mode: "shared" }, () => {})
      .then(() => {
        this.armedResetWatchers.delete(resetId);
        if (this.disposed) return;
        this.enqueueResetState(() => this.onResetPendingReleased(resetId));
      })
      .catch(() => {
        this.armedResetWatchers.delete(resetId);
      });
  }

  private enqueueResetState(step: () => void | Promise<void>): void {
    this.resetStateChain = this.resetStateChain
      .then(async () => {
        if (this.disposed) return;
        await step();
      })
      .catch(() => {});
  }

  private quiesceForReset(): void {
    this.host.onWatchAbort();
    this.host.onEditorSuspendAutosave();
    if (this.ownResetId === null && !this.peerQuiescePromise) {
      this.startPeerQuiesce();
    }
  }

  private startPeerQuiesce(): void {
    if (this.peerQuiescePromise) return;
    const task = this.runPeerQuiesce().finally(() => {
      if (this.peerQuiescePromise === task) this.peerQuiescePromise = null;
    });
    this.peerQuiescePromise = task;
  }

  private async runPeerQuiesce(): Promise<void> {
    if (this.electionAttempt) {
      await Promise.allSettled([this.electionAttempt.promise]);
    }
    if (this.disposed || this.host.isTeardownRequested() || this.ownResetId !== null) return;
    if (!this.hasOwnerState()) return;

    const targetWorkspace = this.host.getWorkspace();
    this.broadcastOwnerStopping("reset");
    this.role = "follower";
    this.currentAttemptId = null;
    this.host.onRoleChange("follower");
    try { this.host.clearOwnedPreview(); } catch {}

    while (!this.disposed && !this.host.isTeardownRequested() && this.ownResetId === null) {
      const ws = this.host.getWorkspace();
      if (ws !== null && targetWorkspace !== null && ws !== targetWorkspace) return;
      const retired = await this.host.retireRuntime({
        mode: "retire-only",
        timeoutMs: this.stopWaitMs,
        shouldBegin: () =>
          this.ownResetId === null &&
          (this.host.getWorkspace() === null || this.host.getWorkspace() === targetWorkspace) &&
          (this.hasOwnerState() || this.host.getWorkspace() === targetWorkspace),
      });
      if (retired.ok) {
        this.releaseOwnerLeasesInOrder();
        return;
      }
      if (retired.reason === "pending-settlement") {
        await retired.pending.catch(() => {});
        continue;
      }
      if (this.ownResetId !== null || (this.host.getWorkspace() !== null && this.host.getWorkspace() !== targetWorkspace)) {
        return;
      }
      // Fail closed: keep Owner leases held so reset requester times out safely rather than mutating under live workers.
      this.host.onReport("Dev server failed to stop for reset — reload this tab to recover");
      return;
    }
  }

  private async onResetPendingReleased(resetId: string): Promise<void> {
    this.peerResetIds.delete(resetId);
    this.markCompletedResetId(resetId);
    await this.syncPendingResetLocks().catch(() => {});
    if (!this.hasActiveResetIntent() && !this.disposed && !this.host.isTeardownRequested()) {
      this.schedulePeerResume();
    }
  }

  private schedulePeerResume(): void {
    this.peerResumeController?.abort();
    const controller = new AbortController();
    this.peerResumeController = controller;
    void this.runPeerResume(controller.signal).finally(() => {
      if (this.peerResumeController === controller) this.peerResumeController = null;
    });
  }

  private async runPeerResume(signal: AbortSignal): Promise<void> {
    try {
      if (this.peerQuiescePromise) {
        await raceAbort(this.peerQuiescePromise.catch(() => {}), signal);
      }
      if (signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return;
      if (this.host.hasTerminalDisposalFailures()) {
        this.host.onReport("Workspace failed to recover after reset — reload this tab");
        return;
      }

      const reopened = await this.ensureWorkspaceReopened(true, signal, () => !this.hasActiveResetIntent());
      if (signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return;
      if (!reopened) {
        this.host.onReport("Workspace failed to reopen after reset — reload this tab");
        return;
      }

      await this.host.onWatchRebind({ reconcile: false, signal });
      if (signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return;

      const resumeLease = await this.enterResetGate({ signal });
      try {
        const ws = this.host.getWorkspace();
        if (!ws) return;
        await this.host.ensureTmpDir(ws, resumeLease, signal);
        await this.host.onRefreshAndSync(resumeLease, signal);
        if (!signal.aborted && !this.disposed && !this.host.isTeardownRequested() && !this.hasActiveResetIntent()) {
          this.host.onEditorResumeAfterReset();
        }
      } finally {
        resumeLease.release();
      }

      if (!signal.aborted && !this.disposed && !this.host.isTeardownRequested() && !this.hasActiveResetIntent()) {
        void this.attemptElection();
      }
    } catch (error) {
      if (signal.aborted || error instanceof ResetInProgressError) {
        void this.syncPendingResetLocks().catch(() => {});
        return;
      }
      this.host.onReport("Workspace recovery after reset failed", error);
    }
  }

  async waitForPendingResets(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const ids = await this.discoverExclusiveResetIds(signal);
      if (ids.length === 0 && !this.hasActiveResetIntent()) return;
      const targets = ids.length > 0 ? ids : Array.from(this.peerResetIds);
      for (const id of targets) {
        if (id === this.ownResetId) continue;
        await this.locks.request(this.lockNames.resetPending(id), { mode: "shared", signal }, () => {});
      }
    }
  }

  async recoverInterruptedReset(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const exclusive = await acquireLockHandle(this.lockNames.resetGate, {
      mode: "exclusive",
      signal,
      locks: this.locks,
    });
    if (!exclusive) throw new Error("Failed to acquire exclusive reset gate for interrupted reset recovery");
    try {
      const state = await raceAbort(this.host.readResetState(), signal);
      this.currentResetGeneration = Math.max(this.currentResetGeneration, state.resetGeneration);
      if (!state.resetInProgress) return;
      const ws = this.host.getWorkspace();
      const identity = ws?.getIdentity() ?? null;
      if (!ws || !identity) throw new Error("Workspace unavailable during interrupted reset recovery");
      await fenceDeadWriters(this.host.scope, ws.fs, this.host.ownClaimIds, { signal, env: this.host.claimsEnv });
      await withWriterClaim(
        this.host.scope,
        identity,
        this.host.ownClaimIds,
        async () => {
          let durableRegistered = false;
          let durableDone!: () => void;
          const durablePromise = new Promise<void>((res) => { durableDone = res; });
          const beforeFirstMutation = () => {
            if (durableRegistered) return;
            if (this.disposed || this.host.isTeardownRequested() || signal?.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            durableRegistered = true;
            void this.host.trackDurableWrite(() => durablePromise).catch(() => {});
          };
          try {
            await this.host.recoverInterruptedResetMutation(ws, signal, beforeFirstMutation);
            await this.host.completeResetTransaction();
          } finally {
            durableDone();
          }
        },
        { signal, env: this.host.claimsEnv },
      );
    } finally {
      exclusive.release();
    }
  }

  private async ensureWorkspaceReopened(
    onlyIfUnusable: boolean,
    signal: AbortSignal,
    shouldReopen?: () => boolean,
  ): Promise<boolean> {
    while (true) {
      const ensured = await this.host.retireRuntime({
        mode: "reopen",
        onlyIfUnusable,
        timeoutMs: this.stopWaitMs,
        signal,
        shouldBegin: shouldReopen,
        shouldReopen,
      });
      if (signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return false;
      if (ensured.ok) return true;
      if (ensured.reason !== "pending-settlement") return false;
      await raceAbort(ensured.pending.catch(() => {}), signal);
      if (signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return false;
    }
  }

  private async acquireSharedResetGateOnce(signal?: AbortSignal): Promise<{ needsRecovery: true } | { needsRecovery: false; lease: ResetGateLease }> {
    const lockHandle = await acquireLockHandle(this.lockNames.resetGate, {
      mode: "shared",
      signal,
      locks: this.locks,
    });
    if (!lockHandle) throw new Error("Failed to acquire shared reset gate lock");
    try {
      const state = await raceAbort(this.host.readResetState(), signal);
      if (state.resetInProgress) {
        lockHandle.release();
        return { needsRecovery: true };
      }
      this.currentResetGeneration = Math.max(this.currentResetGeneration, state.resetGeneration);
      const ws = this.host.getWorkspace();
      if (ws) {
        await fenceDeadWriters(this.host.scope, ws.fs, this.host.ownClaimIds, { signal, env: this.host.claimsEnv });
      }
      const pending = await this.syncPendingResetLocks(signal);
      signal?.throwIfAborted();
      if (pending) throw new ResetInProgressError();
      return {
        needsRecovery: false,
        lease: { resetGeneration: this.currentResetGeneration, release: () => lockHandle.release() },
      };
    } catch (error) {
      lockHandle.release();
      throw error;
    }
  }

  async enterResetGate(
    options: { forWrite?: boolean; signal?: AbortSignal; existingLease?: ResetGateLease } = {},
  ): Promise<ResetGateLease> {
    if (options.existingLease) return options.existingLease;
    const signal = options.signal;
    while (true) {
      signal?.throwIfAborted();
      if (await this.syncPendingResetLocks(signal)) throw new ResetInProgressError();
      signal?.throwIfAborted();
      const attempt = await this.acquireSharedResetGateOnce(signal);
      if (!attempt.needsRecovery) return attempt.lease;
      await this.recoverInterruptedReset(signal);
    }
  }

  private armBusyOwnerWatcher(): void {
    if (this.busyOwnerWatcherController || this.disposed) return;
    const controller = new AbortController();
    this.busyOwnerWatcherController = controller;
    void this.locks
      .request(this.lockNames.owner, { mode: "shared", signal: controller.signal }, () => {})
      .then(() => {
        if (this.busyOwnerWatcherController === controller) this.busyOwnerWatcherController = null;
        if (!controller.signal.aborted && this.role === "follower" && !this.disposed && !this.host.isTeardownRequested() && !this.hasActiveResetIntent()) {
          void this.attemptElection();
        }
      })
      .catch(() => {
        if (this.busyOwnerWatcherController === controller) this.busyOwnerWatcherController = null;
      });
  }

  private armHandoverWatcher(): void {
    if (this.handoverWatcherController || this.disposed) return;
    const controller = new AbortController();
    this.handoverWatcherController = controller;
    void (async () => {
      try {
        await this.locks.request(this.lockNames.handover, { mode: "shared", signal: controller.signal }, () => {});
      } catch {
        return;
      } finally {
        if (this.handoverWatcherController === controller) this.handoverWatcherController = null;
      }
      if (
        !controller.signal.aborted &&
        this.role === "follower" &&
        !this.disposed &&
        !this.host.isTeardownRequested() &&
        !this.hasActiveResetIntent()
      ) {
        void this.attemptElection();
      }
    })();
  }

  attemptElection(): Promise<void> {
    if (this.disposed || this.host.isTeardownRequested() || this.role === "owner" || this.hasActiveResetIntent()) {
      return Promise.resolve();
    }
    if (this.electionAttempt) return this.electionAttempt.promise;
    const controller = new AbortController();
    const promise = this.runAttemptElection(controller.signal).finally(() => {
      if (this.electionAttempt?.controller === controller) this.electionAttempt = null;
    });
    this.electionAttempt = { controller, promise };
    return promise;
  }

  private isHandoverHeldByPeer(snap: LockManagerSnapshot): boolean {
    if (this.handoverLockRelease) return false;
    return (snap.held ?? []).some((h) => h.name === this.lockNames.handover && h.mode === "exclusive");
  }

  private promoteElectionOwner(attemptId: string): void {
    this.role = "owner";
    this.currentAttemptId = attemptId;
    this.busyOwnerWatcherController?.abort();
    this.busyOwnerWatcherController = null;
    this.handoverWatcherController?.abort();
    this.handoverWatcherController = null;
    this.observedAliveWatcherController?.abort();
    this.observedAliveWatcherController = null;
    this.observedOwner = null;
    this.host.onRoleChange("owner");
  }

  private unwindFailedElection(state: {
    promoted: boolean;
    myAttemptId: string;
    releaseElectionArb: (() => void) | null;
    releaseOwner: (() => void) | null;
    releaseAlive: (() => void) | null;
    enteredResetGate: ResetGateLease | null;
    yieldedToHandover: boolean;
    signal: AbortSignal;
  }): void {
    try { state.releaseElectionArb?.(); } catch {}
    if (state.promoted && this.currentAttemptId === state.myAttemptId) {
      this.role = "follower";
      this.currentAttemptId = null;
      this.host.onRoleChange("follower");
      try { this.host.clearOwnedPreview(); } catch {}
    }
    try { state.releaseOwner?.(); } finally {
      try { state.releaseAlive?.(); } finally {
        state.enteredResetGate?.release();
      }
    }
    if (state.yieldedToHandover && !state.signal.aborted && !this.disposed && !this.hasActiveResetIntent()) {
      this.armHandoverWatcher();
    }
  }

  private isSilentElectionError(error: unknown, signal: AbortSignal): boolean {
    return (
      signal.aborted ||
      this.disposed ||
      error instanceof ElectionCancelledError ||
      error instanceof LaunchCancelledError ||
      error instanceof ResetInProgressError
    );
  }

  private async runAttemptElection(signal: AbortSignal): Promise<void> {
    const myAttemptId = crypto.randomUUID();
    let transferred = false;
    let enteredResetGate: ResetGateLease | null = null;
    let releaseElectionArb: (() => void) | null = null;
    let releaseAlive: (() => void) | null = null;
    let releaseOwner: (() => void) | null = null;
    let promoted = false;
    let yieldedToHandover = false;

    try {
      if (signal.aborted || (await this.syncPendingResetLocks(signal)) || signal.aborted) return;
      enteredResetGate = await this.enterResetGate({ forWrite: true, signal });
      if (signal.aborted) return;

      const arb1 = await acquireLockHandle(this.lockNames.electionArb, { mode: "exclusive", signal, locks: this.locks });
      if (!arb1) return;
      releaseElectionArb = arb1.release;
      if (signal.aborted || (await this.syncPendingResetLocks(signal)) || signal.aborted) return;

      const snap = await raceAbort(this.locks.query(), signal);
      if (signal.aborted) return;
      if (this.isHandoverHeldByPeer(snap)) {
        yieldedToHandover = true;
        return;
      }

      const aliveHandle = await acquireLockHandle(this.lockNames.alive(myAttemptId), { mode: "exclusive", signal, locks: this.locks });
      if (!aliveHandle) return;
      releaseAlive = aliveHandle.release;

      const ownerHandle = await acquireLockHandle(this.lockNames.owner, { mode: "exclusive", ifAvailable: true, locks: this.locks });
      if (!ownerHandle) {
        this.armBusyOwnerWatcher();
        return;
      }
      releaseOwner = ownerHandle.release;
      if (this.handoverLockRelease) {
        const rel = this.handoverLockRelease;
        this.handoverLockRelease = null;
        rel();
      }
      releaseElectionArb();
      releaseElectionArb = null;

      const ws = this.host.getWorkspace();
      if (!ws || !this.host.isWorkspaceUsable(ws)) throw new ElectionCancelledError();
      await fenceDeadWriters(this.host.scope, ws.fs, this.host.ownClaimIds, { signal, env: this.host.claimsEnv });
      if (signal.aborted) return;

      const arb2 = await acquireLockHandle(this.lockNames.electionArb, { mode: "exclusive", signal, locks: this.locks });
      if (!arb2) return;
      releaseElectionArb = arb2.release;
      if (signal.aborted || (await this.syncPendingResetLocks(signal)) || signal.aborted) return;

      this.promoteElectionOwner(myAttemptId);
      promoted = true;
      releaseElectionArb();
      releaseElectionArb = null;

      await this.host.launchDevServerAdmission(myAttemptId, signal, () => {
        transferred = true;
        this.ownerLockRelease = releaseOwner;
        this.aliveLockRelease = releaseAlive;
        this.ownerResetGateLease = enteredResetGate;
      });
    } catch (error) {
      if (!this.isSilentElectionError(error, signal)) {
        this.host.onReport("Dev server ownership election failed", error);
      }
    } finally {
      if (!transferred) {
        this.unwindFailedElection({
          promoted,
          myAttemptId,
          releaseElectionArb,
          releaseOwner,
          releaseAlive,
          enteredResetGate,
          yieldedToHandover,
          signal,
        });
      }
    }
  }

  enqueueOwnerAction<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ownerActionQueue.then(fn, fn);
    this.ownerActionQueue = next.then(() => {}, () => {});
    return next;
  }

  private isActiveOwnerAttempt(attemptId: string, signal?: AbortSignal): boolean {
    return (
      !signal?.aborted &&
      this.role === "owner" &&
      this.currentAttemptId === attemptId &&
      !this.disposed &&
      !this.host.isTeardownRequested() &&
      !this.hasActiveResetIntent()
    );
  }

  private needsRuntimeRecycleBeforeRestart(): boolean {
    const ws = this.host.getWorkspace();
    return (
      !this.host.isWorkspaceUsable(ws) ||
      ws.launchInvalidated ||
      this.host.hasUnsettledDisposals() ||
      this.host.hasProvisionalReopen() ||
      this.host.hasDevState() ||
      this.host.hasPendingDevClaim() ||
      this.host.hasActiveLaunchReservation()
    );
  }

  private async runOwnerRestart(attemptId: string, controller: AbortController): Promise<{ ok: boolean; error?: string }> {
    const pending = await this.syncPendingResetLocks(controller.signal);
    if (controller.signal.aborted || pending || this.hasActiveResetIntent()) {
      return { ok: false, error: "Reset in progress" };
    }
    await this.host.repairBaseProgramsIfNeeded(controller.signal);
    const pending2 = await this.syncPendingResetLocks(controller.signal);
    if (pending2 || !this.isActiveOwnerAttempt(attemptId, controller.signal)) {
      return { ok: false, error: "Ownership or reset state changed" };
    }
    if (this.needsRuntimeRecycleBeforeRestart()) {
      const retired = await this.host.retireRuntime({
        mode: "reopen",
        timeoutMs: this.stopWaitMs,
        signal: controller.signal,
        shouldBegin: () => this.isActiveOwnerAttempt(attemptId),
        shouldReopen: () => this.isActiveOwnerAttempt(attemptId),
      });
      if (!retired.ok) {
        if (retired.reason === "pending-settlement" && this.isActiveOwnerAttempt(attemptId, controller.signal)) {
          this.scheduleOwnerRecovery(attemptId, retired.pending);
        }
        return { ok: false, error: "Previous dev server did not retire cleanly" };
      }
    }
    if (!this.isActiveOwnerAttempt(attemptId, controller.signal) || !this.host.isWorkspaceUsable(this.host.getWorkspace())) {
      return { ok: false, error: "Ownership or reset state changed" };
    }
    await this.host.launchDevServerAdmission(attemptId, controller.signal);
    return { ok: true };
  }

  async restartOwnedDevServer(): Promise<{ ok: boolean; error?: string }> {
    this.ownerRecovery?.controller.abort();
    return this.enqueueOwnerAction(async () => {
      this.ownerRecovery?.controller.abort();
      if (this.electionAttempt) await Promise.allSettled([this.electionAttempt.promise]);
      if (this.currentAttemptId === null || !this.isActiveOwnerAttempt(this.currentAttemptId)) {
        return { ok: false, error: "Not the active dev server owner" };
      }
      const attemptId = this.currentAttemptId;
      const controller = new AbortController();
      this.restartLaunchController?.abort();
      this.restartLaunchController = controller;
      try {
        return await this.runOwnerRestart(attemptId, controller);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (this.restartLaunchController === controller) this.restartLaunchController = null;
      }
    });
  }

  private scheduleOwnerRecovery(attemptId: string, pending: Promise<unknown>): void {
    this.ownerRecovery?.controller.abort();
    const controller = new AbortController();
    const promise = (async () => {
      try {
        await raceAbort(pending.catch(() => {}), controller.signal);
        if (controller.signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return;
        await this.enqueueOwnerAction(async () => {
          if (
            controller.signal.aborted ||
            this.disposed ||
            this.host.isTeardownRequested() ||
            this.hasActiveResetIntent() ||
            this.role !== "owner" ||
            this.currentAttemptId !== attemptId
          ) {
            return;
          }
          while (true) {
            const ensured = await this.host.retireRuntime({
              mode: "reopen",
              timeoutMs: this.stopWaitMs,
              signal: controller.signal,
              shouldBegin: () => !this.hasActiveResetIntent() && this.role === "owner" && this.currentAttemptId === attemptId,
              shouldReopen: () => !this.hasActiveResetIntent() && this.role === "owner" && this.currentAttemptId === attemptId,
            });
            if (controller.signal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent()) return;
            if (ensured.ok) {
              this.demoteAndReleaseOwnerLeases();
              void this.attemptElection();
              return;
            }
            if (ensured.reason === "pending-settlement") {
              await raceAbort(ensured.pending.catch(() => {}), controller.signal);
              continue;
            }
            this.host.onReport("Dev server failed to recover — reload this tab");
            return;
          }
        });
      } catch {
        // Cancelled by newer reset, restart, or teardown.
      }
    })().finally(() => {
      if (this.ownerRecovery?.controller === controller) this.ownerRecovery = null;
    });
    this.ownerRecovery = { controller, promise };
  }

  private demoteAndReleaseOwnerLeases(): void {
    const ownerRel = this.ownerLockRelease;
    const aliveRel = this.aliveLockRelease;
    const gateRel = this.ownerResetGateLease;
    this.role = "follower";
    this.currentAttemptId = null;
    this.ownerLockRelease = null;
    this.aliveLockRelease = null;
    this.ownerResetGateLease = null;
    this.host.onRoleChange("follower");
    try {
      this.host.clearOwnedPreview();
    } finally {
      try { ownerRel?.(); } finally {
        try { aliveRel?.(); } finally {
          gateRel?.release();
        }
      }
    }
  }

  private async isHandoverReservationHeld(handoverId: string, signal?: AbortSignal): Promise<boolean> {
    const snap = await raceAbort(this.locks.query(), signal);
    const held = snap.held ?? [];
    const reqLock = held.find((h) => h.name === this.lockNames.handoverRequest(handoverId) && h.mode === "exclusive");
    const handLock = held.find((h) => h.name === this.lockNames.handover && h.mode === "exclusive");
    return Boolean(reqLock && handLock && reqLock.clientId && reqLock.clientId === handLock.clientId);
  }

  private handleRestartRequest(request: Extract<CoordinatorMessage, { type: "restart-request" }>): void {
    if (request.engine === this.host.engine && !request.handoverId) {
      if (
        this.hasActiveResetIntent() ||
        this.resetInFlight ||
        this.role !== "owner" ||
        this.currentAttemptId !== request.targetAttemptId ||
        request.targetOwnerId !== this.host.tabId
      ) {
        this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: false, error: "Target owner attempt or state changed", from: this.host.tabId });
        return;
      }
      void this.restartOwnedDevServer().then((res) => {
        this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: res.ok, error: res.error, from: this.host.tabId });
      });
      return;
    }

    // Targeted cross-engine handover.
    const handoverId = request.handoverId;
    if (
      !handoverId ||
      this.hasActiveResetIntent() ||
      this.resetInFlight ||
      this.role !== "owner" ||
      this.currentAttemptId === null ||
      this.host.getWorkspace() === null ||
      this.disposed ||
      this.host.isTeardownRequested() ||
      request.targetOwnerId !== this.host.tabId ||
      request.targetAttemptId !== this.currentAttemptId
    ) {
      this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: false, error: "Target owner attempt or state changed", from: this.host.tabId });
      return;
    }

    const handoverAttemptId = this.currentAttemptId;
    const handoverWorkspace = this.host.getWorkspace()!;
    const controller = new AbortController();
    const promise = this.enqueueOwnerAction(async () => {
      try {
        if (
          controller.signal.aborted ||
          this.hasActiveResetIntent() ||
          this.resetInFlight ||
          this.role !== "owner" ||
          this.currentAttemptId !== handoverAttemptId ||
          this.host.getWorkspace() !== handoverWorkspace ||
          !(await this.isHandoverReservationHeld(handoverId, controller.signal))
        ) {
          this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: false, error: "Handover request expired or cancelled", from: this.host.tabId });
          return;
        }

        const retired = await this.host.retireRuntime({
          mode: "reopen",
          timeoutMs: this.stopWaitMs,
          signal: controller.signal,
          shouldBegin: () =>
            !this.hasActiveResetIntent() &&
            !this.resetInFlight &&
            this.role === "owner" &&
            this.currentAttemptId === handoverAttemptId &&
            this.host.getWorkspace() === handoverWorkspace,
          confirmBegin: (sig) => this.isHandoverReservationHeld(handoverId, sig),
          shouldReopen: () =>
            !this.hasActiveResetIntent() &&
            !this.resetInFlight &&
            this.role === "owner" &&
            this.currentAttemptId === handoverAttemptId,
        });

        if (
          !retired.ok ||
          controller.signal.aborted ||
          this.hasActiveResetIntent() ||
          this.resetInFlight ||
          this.role !== "owner" ||
          this.currentAttemptId !== handoverAttemptId
        ) {
          this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: false, error: "Handover retirement failed", from: this.host.tabId });
          if (
            !retired.ok &&
            retired.reason === "pending-settlement" &&
            !controller.signal.aborted &&
            !this.hasActiveResetIntent() &&
            !this.resetInFlight &&
            !this.disposed &&
            !this.host.isTeardownRequested() &&
            this.role === "owner" &&
            this.currentAttemptId === handoverAttemptId
          ) {
            this.scheduleOwnerRecovery(handoverAttemptId, retired.pending);
          } else if (
            !retired.ok &&
            retired.reason === "other" &&
            !controller.signal.aborted &&
            !this.hasActiveResetIntent() &&
            !this.resetInFlight &&
            !this.disposed &&
            !this.host.isTeardownRequested() &&
            this.role === "owner" &&
            this.currentAttemptId === handoverAttemptId &&
            (this.host.getWorkspace() !== handoverWorkspace ||
              this.host.getWorkspace()?.launchInvalidated ||
              !this.host.hasActiveDevLaunchForCurrentWorkspace())
          ) {
            this.host.onReport("Dev server handover failed — reload this tab");
          }
          return;
        }

        this.broadcastOwnerStopping("handover");
        this.demoteAndReleaseOwnerLeases();
        this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: true, handover: true, from: this.host.tabId });
        this.armHandoverWatcher();
      } catch {
        this.broadcast({ type: "restart-ack", requestId: request.requestId, accepted: false, error: "Handover aborted", from: this.host.tabId });
      }
    }).finally(() => {
      if (this.activeHandover?.controller === controller) this.activeHandover = null;
    });
    this.activeHandover = { controller, promise };
  }

  async requestRestartOrHandover(): Promise<{ ok: boolean; error?: string }> {
    if (this.role === "owner") return this.restartOwnedDevServer();
    if (!this.observedOwner) {
      await this.attemptElection();
      return { ok: this.isOwnerRole() };
    }
    const target = this.observedOwner;
    if (target.engine === this.host.engine) {
      const requestId = crypto.randomUUID();
      const ack = Promise.withResolvers<{ accepted: boolean; handover?: boolean; error?: string }>();
      this.pendingRestartAcks.set(requestId, ack);
      this.broadcast({
        type: "restart-request",
        requestId,
        targetOwnerId: target.ownerId,
        targetAttemptId: target.attemptId,
        engine: this.host.engine,
        from: this.host.tabId,
      });
      const timer = setTimeout(() => {
        if (this.pendingRestartAcks.delete(requestId)) ack.resolve({ accepted: false, error: "Restart request timed out" });
      }, this.stopWaitMs);
      const res = await ack.promise.finally(() => clearTimeout(timer));
      return { ok: res.accepted, error: res.error };
    }

    // Cross-engine handover: acquire singleton handoverLock + handoverRequestLock inside electionArbLock.
    const handoverId = crypto.randomUUID();
    let releaseHandover: (() => void) | null = null;
    let releaseHandoverRequest: (() => void) | null = null;
    let accepted = false;
    try {
      const arb = await acquireLockHandle(this.lockNames.electionArb, { mode: "exclusive", locks: this.locks });
      try {
        const hand = await acquireLockHandle(this.lockNames.handover, { mode: "exclusive", ifAvailable: true, locks: this.locks });
        if (!hand) return { ok: false, error: "Another handover is already in progress" };
        releaseHandover = hand.release;
        const reqLock = await acquireLockHandle(this.lockNames.handoverRequest(handoverId), { mode: "exclusive", locks: this.locks });
        if (!reqLock) return { ok: false, error: "Failed to reserve handover request" };
        releaseHandoverRequest = reqLock.release;
      } finally {
        arb?.release();
      }

      try {
        const ack = Promise.withResolvers<{ accepted: boolean; handover?: boolean; error?: string }>();
        this.pendingRestartAcks.set(handoverId, ack);
        this.broadcast({
          type: "restart-request",
          requestId: handoverId,
          handoverId,
          targetOwnerId: target.ownerId,
          targetAttemptId: target.attemptId,
          engine: this.host.engine,
          from: this.host.tabId,
        });
        const timer = setTimeout(() => {
          if (this.pendingRestartAcks.delete(handoverId)) ack.resolve({ accepted: false, error: "Handover timed out" });
        }, this.stopWaitMs);
        const res = await ack.promise.finally(() => clearTimeout(timer));
        if (!res.accepted) return { ok: false, error: res.error ?? "Handover rejected" };
        accepted = true;
      } finally {
        releaseHandoverRequest?.();
        releaseHandoverRequest = null;
      }

      this.handoverLockRelease = releaseHandover;
      releaseHandover = null;
      await this.attemptElection();
      return { ok: this.isOwnerRole() };
    } finally {
      if (!accepted && releaseHandover) releaseHandover();
      if (this.handoverLockRelease) {
        const rel = this.handoverLockRelease;
        this.handoverLockRelease = null;
        rel();
      }
    }
  }

  private async publishOwnResetPending(
    resetId: string,
    preMutationDeadline: number,
    signal: AbortSignal,
  ): Promise<() => void> {
    const arb = await acquireLockHandle(this.lockNames.electionArb, { mode: "exclusive", signal, locks: this.locks });
    if (!arb) throw new ResetAbortedError();
    try {
      await this.syncPendingResetLocks(signal);
      if (signal.aborted || performance.now() >= preMutationDeadline || this.disposed || this.host.isTeardownRequested() || this.peerResetIds.size > 0) {
        throw new ResetYieldError();
      }
      const grant = await acquireLockHandle(this.lockNames.resetPending(resetId), { mode: "exclusive", signal, locks: this.locks });
      if (!grant) throw new ResetAbortedError();
      if (signal.aborted || performance.now() >= preMutationDeadline || this.disposed || this.host.isTeardownRequested()) {
        grant.release();
        throw new ResetAbortedError();
      }
      this.ownResetPublished = true;
      return grant.release;
    } finally {
      arb.release();
    }
  }

  private async joinPreResetActivities(signal: AbortSignal): Promise<void> {
    if (this.peerQuiescePromise) await raceAbort(this.peerQuiescePromise.catch(() => {}), signal);
    if (this.activeHandover) await raceAbort(this.activeHandover.promise.catch(() => {}), signal);
    if (this.ownerRecovery) await raceAbort(this.ownerRecovery.promise.catch(() => {}), signal);
    if (this.electionAttempt) await raceAbort(this.electionAttempt.promise.catch(() => {}), signal);
    if (this.host.hasPendingDevClaim()) await this.host.joinPendingDevClaim(signal);
  }

  private async joinPostResetActivities(signal: AbortSignal): Promise<void> {
    await this.joinPreResetActivities(signal);
    if (this.host.hasLifecycleTransition()) await this.host.joinLifecycleTransition(signal);
    if (this.host.hasUncommittedProvisions()) await this.host.joinUncommittedProvisions(signal);
  }

  private finalizeResetPending(resetId: string, published: boolean, releasePending: (() => void) | null): void {
    try {
      if (published) this.broadcast({ type: "reset-end", resetId, from: this.host.tabId });
    } catch {}
    finally {
      releasePending?.();
      this.markCompletedResetId(resetId);
      if (this.ownResetId === resetId) {
        this.ownResetId = null;
        this.ownResetPublished = false;
        this.ownResetMutationStarted = false;
        this.resetCancelController = null;
      }
    }
  }

  private async releaseResetResources(
    resetId: string,
    published: boolean,
    resetClaim: WriterClaimHandle | null,
    releaseGate: (() => void) | null,
    releasePending: (() => void) | null,
  ): Promise<void> {
    try {
      if (resetClaim) await resetClaim.release(performance.now() + 1_000).catch(() => {});
    } finally {
      try { releaseGate?.(); } finally {
        this.finalizeResetPending(resetId, published, releasePending);
      }
    }
  }

  private isResetWorkspaceReady(ws: CoordinatorWorkspace, signal: AbortSignal, deadline: number): boolean {
    return (
      !signal.aborted &&
      performance.now() < deadline &&
      !this.disposed &&
      !this.host.isTeardownRequested() &&
      this.host.getWorkspace() === ws &&
      this.host.isWorkspaceUsable(ws)
    );
  }

  private isLiveCommittedOwnerAfterAbort(ownerRetirementStarted: boolean, ownerLeasesReleased: boolean): boolean {
    const wsNow = this.host.getWorkspace();
    return (
      !ownerRetirementStarted &&
      !ownerLeasesReleased &&
      this.role === "owner" &&
      this.ownerLockRelease !== null &&
      this.aliveLockRelease !== null &&
      this.ownerResetGateLease !== null &&
      this.host.isWorkspaceUsable(wsNow) &&
      !wsNow.launchInvalidated &&
      this.host.hasActiveDevLaunchForCurrentWorkspace()
    );
  }

  private hasCleanHostDisposalState(): boolean {
    return (
      !this.host.hasRollbackFailure() &&
      !this.host.hasTerminalDisposalFailures() &&
      !this.host.hasUnsettledDisposals() &&
      !this.host.hasProvisionalReopen()
    );
  }

  private isRetirementProvenForOwnerRelease(liveDevWorkspace: CoordinatorWorkspace | null): boolean {
    const postWs = this.host.getWorkspace();
    return (
      (liveDevWorkspace === null || postWs !== liveDevWorkspace) &&
      this.host.isWorkspaceUsable(postWs) &&
      !postWs.launchInvalidated &&
      !this.host.hasActiveDevLaunchForCurrentWorkspace() &&
      !this.host.hasDevState() &&
      !this.host.hasPendingDevClaim() &&
      !this.host.hasActiveLaunchReservation() &&
      this.hasCleanHostDisposalState()
    );
  }

  private async recoverAbortedReset(
    ownerRetirementStarted: boolean,
    ownerLeasesReleased: boolean,
    devWorkspaceAtStart: CoordinatorWorkspace | null,
    resetError: unknown,
  ): Promise<void> {
    this.peerResumeController?.abort();
    const recoveryController = new AbortController();
    this.peerResumeController = recoveryController;
    const recoverySignal = recoveryController.signal;
    const cancelled = () => recoverySignal.aborted || this.disposed || this.host.isTeardownRequested() || this.hasActiveResetIntent();

    try {
      await this.joinPostResetActivities(recoverySignal);
      if (cancelled()) return;

      let ownerPreserved = false;
      if (this.isLiveCommittedOwnerAfterAbort(ownerRetirementStarted, ownerLeasesReleased)) {
        if (!this.hasCleanHostDisposalState()) {
          this.host.onReport("Reset failed to recover runtime — reload this tab", resetError);
          return;
        }
        ownerPreserved = true;
      } else {
        const liveDevWorkspace = this.host.getActiveDevWorkspace() ?? devWorkspaceAtStart;
        const mustForceRetire =
          (liveDevWorkspace !== null && this.host.getWorkspace() === liveDevWorkspace) ||
          Boolean(this.host.getWorkspace()?.launchInvalidated) ||
          this.host.hasDevState();
        const reopened = await this.ensureWorkspaceReopened(!mustForceRetire, recoverySignal, () => !this.hasActiveResetIntent());
        if (cancelled()) return;
        if (!reopened) {
          this.host.onReport("Reset failed to recover runtime — reload this tab", resetError);
          return;
        }
        const hasOwnerLeases = !ownerLeasesReleased && (this.ownerLockRelease !== null || this.aliveLockRelease !== null || this.ownerResetGateLease !== null);
        if (hasOwnerLeases && !this.isRetirementProvenForOwnerRelease(liveDevWorkspace)) {
          this.host.onReport("Reset failed to prove runtime retirement — reload this tab", resetError);
          return;
        }
        if (hasOwnerLeases) this.demoteAndReleaseOwnerLeases();
      }

      if (cancelled()) return;
      if (resetError && !(resetError instanceof ResetYieldError)) {
        this.host.onReport("Workspace reset did not complete", resetError);
      }

      await this.host.onWatchRebind({ reconcile: false, signal: recoverySignal });
      if (cancelled()) return;
      if (ownerPreserved) {
        this.host.onEditorResumeAfterReset();
        return;
      }

      const lease = await this.enterResetGate({ signal: recoverySignal });
      try {
        const postWs = this.host.getWorkspace();
        if (!postWs) return;
        await this.host.ensureTmpDir(postWs, lease, recoverySignal);
        await this.host.onRefreshAndSync(lease, recoverySignal);
        if (!cancelled()) this.host.onEditorResumeAfterReset();
      } finally {
        lease.release();
      }
      if (!cancelled()) void this.attemptElection();
    } catch (err) {
      if (recoverySignal.aborted || err instanceof ResetInProgressError) {
        void this.syncPendingResetLocks().catch(() => {});
        return;
      }
      this.host.onReport("Workspace reset recovery failed", err);
    } finally {
      if (this.peerResumeController === recoveryController) this.peerResumeController = null;
    }
  }

  private async retireOrReopenForReset(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ ownerRetirementStarted: boolean; ownerLeasesReleased: boolean }> {
    if (this.hasOwnerState()) {
      this.broadcastOwnerStopping("reset");
      const retired = await this.host.retireRuntime({ mode: "reopen", timeoutMs, signal });
      if (!retired.ok) throw new ResetAbortedError("Owner failed to retire before reset");
      this.demoteAndReleaseOwnerLeases();
      return { ownerRetirementStarted: true, ownerLeasesReleased: true };
    }
    const ensured = await this.host.retireRuntime({ mode: "reopen", onlyIfUnusable: true, timeoutMs, signal });
    if (!ensured.ok) throw new ResetAbortedError("Workspace failed to reopen before reset");
    return { ownerRetirementStarted: false, ownerLeasesReleased: false };
  }

  /** Coordinated atomic workspace-wide reset barrier (§5.3.4). */
  async resetWorkspace(): Promise<void> {
    if (this.resetInFlight || this.ownResetId !== null || this.disposed || this.host.isTeardownRequested()) return;
    this.resetInFlight = true;
    const resetId = crypto.randomUUID();
    const resetCancelController = new AbortController();
    const preMutationController = new AbortController();
    const onCancel = () => preMutationController.abort(resetCancelController.signal.reason ?? new ResetAbortedError());
    resetCancelController.signal.addEventListener("abort", onCancel, { once: true });
    const preMutationDeadline = performance.now() + this.stopWaitMs;
    const preMutationTimer = setTimeout(
      () => preMutationController.abort(new DOMException("Reset pre-mutation timed out", "AbortError")),
      this.stopWaitMs,
    );
    const preMutationSignal = preMutationController.signal;

    let published = false;
    let committed = false;
    let ownerRetirementStarted = false;
    let ownerLeasesReleased = false;
    let releasePending: (() => void) | null = null;
    let releaseGate: (() => void) | null = null;
    let resetClaim: WriterClaimHandle | null = null;
    let resetError: unknown = null;
    const devWorkspaceAtStart = this.host.getActiveDevWorkspace();

    this.ownResetId = resetId;
    this.ownResetPublished = false;
    this.ownResetMutationStarted = false;
    this.resetCancelController = resetCancelController;
    this.electionAttempt?.controller.abort();
    this.restartLaunchController?.abort();
    this.activeHandover?.controller.abort();
    this.ownerRecovery?.controller.abort();
    this.handoverWatcherController?.abort();
    this.peerResumeController?.abort();
    this.host.onEditorSuspendAutosave();

    const remaining = () => Math.max(1, preMutationDeadline - performance.now());

    try {
      try {
        releasePending = await this.publishOwnResetPending(resetId, preMutationDeadline, preMutationSignal);
        published = true;
        this.broadcast({ type: "reset-begin", resetId, from: this.host.tabId });

        const files = await this.host.fetchTemplateSources(preMutationSignal);
        await this.joinPreResetActivities(preMutationSignal);

        if (this.hasOwnerState()) ownerRetirementStarted = true;
        const prep = await this.retireOrReopenForReset(remaining(), preMutationSignal);
        ownerRetirementStarted ||= prep.ownerRetirementStarted;
        ownerLeasesReleased = prep.ownerLeasesReleased;

        const resetWorkspace = this.host.getWorkspace();
        const resetIdentity = resetWorkspace?.getIdentity() ?? null;
        if (!resetWorkspace || resetWorkspace.runtime.disposed || !resetIdentity) {
          throw new ResetAbortedError("Reset workspace unavailable");
        }

        await raceAbort(this.host.waitForOwnResetGateIdle(), preMutationSignal);
        const gateGrant = await acquireLockHandle(this.lockNames.resetGate, { mode: "exclusive", signal: preMutationSignal, locks: this.locks });
        if (!gateGrant) throw new ResetAbortedError();
        releaseGate = gateGrant.release;

        await fenceDeadWriters(this.host.scope, resetWorkspace.fs, this.host.ownClaimIds, { signal: preMutationSignal, env: this.host.claimsEnv });
        resetClaim = await acquireWriterClaim(this.host.scope, resetIdentity, this.host.ownClaimIds, { signal: preMutationSignal, env: this.host.claimsEnv });
        await probeFilesystemReady(resetWorkspace.fs, preMutationSignal);

        if (!this.isResetWorkspaceReady(resetWorkspace, preMutationSignal, preMutationDeadline)) {
          throw new ResetAbortedError("Reset cancelled, timed out, or storage failed before mutation");
        }
        clearTimeout(preMutationTimer);

        await this.host.trackDurableWrite(async () => {
          const nextGen = await this.host.beginResetTransaction();
          this.currentResetGeneration = Math.max(this.currentResetGeneration, nextGen);
          this.ownResetMutationStarted = true;
          await this.host.runCoordinatedResetMutation(resetWorkspace, files);
          await this.host.completeResetTransaction();
          committed = true;
        });
      } catch (error) {
        resetError = error;
      } finally {
        clearTimeout(preMutationTimer);
        resetCancelController.signal.removeEventListener("abort", onCancel);
        await this.releaseResetResources(resetId, published, resetClaim, releaseGate, releasePending);
      }

      if (this.disposed || this.host.isTeardownRequested()) return;
      if (committed) {
        this.host.onEditorDiscard();
        this.host.onResetCommittedReload();
        return;
      }
      if (this.peerResetIds.size > 0) {
        this.enqueueResetState(() => this.quiesceForReset());
        return;
      }
      await this.recoverAbortedReset(ownerRetirementStarted, ownerLeasesReleased, devWorkspaceAtStart, resetError);
    } finally {
      this.resetInFlight = false;
    }
  }
}
