import { TypedEventTarget } from "@remix-run/component";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createRuntime, openIdleWorkspace, storedWorkspaces, type Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { memoryGroupPolicy } from "../../web/src/host-memory-policy";
import { parseMemoryProfile, type ProgramMemoryProfile } from "../../web/src/program-profile";
import { templateProfile } from "../../web/src/playground/program-profile";
import { installBunSharedObjects } from "../../src/shared-objects";
import { BrowserPrograms, ProvisionAbortedError, type ProvisioningStatus } from "../../web/src/browser-programs";
import { ENGINES, type Engine, WasmMissing, isEngine, loadEngineProgram, mb, registerModuleScope } from "../../web/src/engine-loader";
import { decode } from "../../web/src/fs";
import { HostedPreviews } from "../../web/src/hosted-previews";
import type { BunNetworkOptions, RuntimeNetworkHelper } from "../../web/src/net/helper";
import { Previews, type PreviewState } from "../../web/src/preview";
import type { Run, RunHooks, RunOptions, RunResult } from "../../web/src/runner";
import { getVfsDescriptor, UNSAVED_CHANGES_LOST, WORKSPACE_TAKEN_OVER } from "../../web/src/shared-fs";
import { START_FRESH_BUSY, startFresh, unreadableWorkspace } from "../../web/src/start-fresh";
import { errorText, measureStartup } from "../../web/src/startup";
import { entryAssetName, entryAssetUrl } from "../../web/src/entry-assets";
import { openTerminal } from "../../web/src/terminal-mount";
import { linkLocalUrls } from "../../web/src/terminal-links";
import {
  acquireLockHandle,
  acquireWriterClaim,
  createWorkerIdentityObserver,
  liveWritersLockName,
  pageAliveLockName,
  presenceLockName,
  probeFilesystemReady,
  raceAbort,
  trackUnsettledPromise,
  verifyWorkerLocksReleased,
  withDeadline,
  withWriterClaim,
  type LockHandle,
  type PartialWorkerIdentity,
  type PeerWorkerIdentity,
  type WorkerIdentityObserver,
  type WriterClaimHandle,
} from "../../web/src/workspace-claims";
import {
  upgradeReactRouterPreviewMount,
  withExclusiveLiveWriters,
  withProvisionBinsLock,
  withProvisionSeedLock,
} from "../../web/src/workspace-provision";
import { startWorkspaceWatch, type ReconcileReason, type WorkspaceWatchHandle } from "../../web/src/workspace-watch";
import {
  coordinatorLocks,
  DevServerCoordinator,
  LaunchCancelledError,
  ResetGenerationMismatchError,
  ResetInProgressError,
  type CoordinatorWorkspace,
  type OwnerBroadcastState,
  type ResetGateLease,
  type RetireOptions,
  type RetireResult,
} from "./dev-server-coordinator";
import { Editor } from "./editor";
import { StartupOutput } from "./startup-output";
import { fetchTemplateSources, loadTemplate, writeTemplateSources, type TemplateSources } from "./template";
import { defaultTemplate, selectTemplate, type Template } from "./template-catalog";
import { isStorageFull, workspaceName } from "./workspace-policy";
import { restoreSource } from "./workspace-restore";
import { PreservationRefused } from "./workspace-source";
import { WorkspaceStorage } from "./workspace-storage";
import type { EvictionReport } from "./workspace-eviction";

type Filesystem = Runtime["filesystem"];
export type Status = { text: string; kind: "" | "ok" | "error" };
/** No state until startup reaches the dev server. */
export type ServerState = { state?: "starting" | "up" | "down"; text: string; url?: string };
/** Why Restart became Reload; any failure locks the workspace controls. */
export type Failure = "construction" | "startup" | "storage";

const HOME = "/home/user";
const APP = `${HOME}/app`;
const PORT = 5173;
const DEFAULT_ENGINE: Engine = "browser";
const STOP_WAIT_MS = 30_000;

interface WorkspaceRuntime extends CoordinatorWorkspace {
  readonly runtime: Runtime;
  readonly fs: Filesystem;
  readonly sharedObjects: ReturnType<typeof installBunSharedObjects>;
  readonly browserPrograms: BrowserPrograms;
  readonly moduleScope: Promise<boolean>;
  readonly workerInstanceId: string;
  readonly identityReady: Promise<PeerWorkerIdentity> | null;
  getIdentity(): PeerWorkerIdentity | null;
  getPartialWorkerIdentity(): PartialWorkerIdentity;
  disposeIdentityObserver(): void;
  launchInvalidated: boolean;
}

interface Server {
  port: number;
  helper?: RuntimeNetworkHelper;
  token?: symbol;
  remoteKey?: string;
}

export interface PreviewNavigation {
  server: Server;
  frame: HTMLIFrameElement;
  url: string;
  loaded: { document: Document; url: string } | null;
}

function runCleanup(fn: () => Promise<unknown> | void): Promise<void> {
  try { return Promise.resolve(fn()).then(() => {}); } catch (err) { return Promise.reject(err); }
}

/** One Waffle runtime installs the selected project and runs its dev script. */
export class Sandbox extends TypedEventTarget<{ change: Event }> {
  readonly tabId = crypto.randomUUID();
  get template(): Template["id"] { return this.project.id; }
  readonly engine: Engine;
  readonly profile: ProgramMemoryProfile;
  failure?: Failure;
  unreadable = false;
  resetting = false;
  workspaceInitialized = false;
  storageNotice = "";
  files: string[] = [];
  serverState: ServerState = { text: "starting dev server…" };
  previewLink = "#";

  private readonly params: URLSearchParams;
  private readonly project: Template;
  private readonly fit = new FitAddon();
  private terminalOpened!: () => void;
  private readonly terminalOpen = new Promise<void>((resolve) => { this.terminalOpened = resolve; });
  private message: Status = { text: "", kind: "" };
  private started = false;
  private disposed = false;
  private teardownRequested = false;
  private ownershipLostFlag = false;
  private editorMounted = false;
  private localResetting = false;
  private attachEnabled = false;
  private runtimeRetiredCleanly = false;

  private workspace: WorkspaceRuntime | null = null;
  private provisionalReopen: WorkspaceRuntime | null = null;
  private editorInstance: Editor | undefined;
  private termInstance: Terminal | undefined;
  private storage?: WorkspaceStorage;
  private storageError = "";
  private startup?: Promise<void>;
  private frame?: HTMLIFrameElement;
  private filesRevision = 0;
  private previews!: Previews;
  private coordinator: DevServerCoordinator | null = null;
  private watch: WorkspaceWatchHandle | null = null;
  private disposePreviewRecovery?: () => void;
  private wasm: Awaited<ReturnType<typeof loadEngineProgram>> | null = null;
  private engineLoading?: Promise<void>;
  private firstStart = true;

  private run: Run | null = null;
  private readonly stopping = new Set<StoppingRun>();
  private server: Server | null = null;
  private preview: PreviewNavigation | null = null;
  private serverRevision = 0;
  private listenerRevision = 0;
  private serverTiming = { started: 0, visibleStart: 0 };
  private refreshFilesThrottleTimer: ReturnType<typeof setTimeout> | null = null;

  // Coordination, lifecycle, claim, and teardown tracking.
  private presenceLock: LockHandle | null = null;
  private pageAliveLock: LockHandle | null = null;
  private releaseLiveWriters: (() => void) | null = null;
  private readonly ownClaimIds = new Set<string>();
  private devClaimHandle: WriterClaimHandle | null = null;
  private runtimeUsedForDev = false;
  private activeDevLaunch: { attemptId: string; workspace: WorkspaceRuntime; revision: number } | null = null;
  private activeLaunchReservation: { attemptId: string; revision: number } | null = null;
  private pendingDevClaim: Promise<void> | null = null;

  private readonly admittedPageReads = new Set<Promise<void>>();
  private readonly admittedPageWrites = new Set<Promise<void>>();
  private readonly activePageResetLeases = new Set<ResetGateLease>();
  private readonly ownGateIdleWaiters = new Set<() => void>();
  private readonly localStartupPhases = new Set<{ controller: AbortController; done: Promise<void> }>();
  private readonly uncommittedProvisions = new Set<{ controller: AbortController; settled: Promise<void> }>();
  private readonly provisioningState = new Map<"base" | "bun", ProvisioningStatus>();
  private readonly unsettledDisposals = new Set<Promise<void>>();
  private readonly terminalDisposalFailures: unknown[] = [];
  private readonly intentionallyDisposedRuntimes = new WeakSet<Runtime>();

  private lifecycleTransition: Promise<void> | null = null;
  private runtimeRecycling: { promise: Promise<void>; resolve: () => void } | null = null;
  private provisionalBoot: { controller: AbortController; promise: Promise<void> } | null = null;
  private teardownPromise: Promise<void> | null = null;
  private teardownContinuation: Promise<void> | null = null;
  private readonly pagehideHandler = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    void this.teardown();
  };

  private readonly network: BunNetworkOptions = {
    listening: (port, helper) => {
      if (this.disposed || this.teardownRequested) return;
      this.listenerRevision++;
      const token = this.previews.registerListener(port, helper);
      const server: Server = { port, helper, token };
      this.server = server;
      measureStartup("dev-server", this.serverTiming.started, { port });
      void this.showPreview(server, this.serverTiming.visibleStart).catch(this.report);
    },
    stopped: (port, helper) => {
      performance.mark("bunwasm:listener-stopped", { detail: { port } });
      if (this.server?.helper === helper && this.server.token) {
        this.previews.unregisterListener(port, this.server.token);
      } else {
        this.previews.unregister(port, helper);
      }
      if (this.server?.helper !== helper) return;
      this.server = null;
      this.setServerState("down", "dev server stopped · press Restart");
      this.coordinator?.broadcastOwnerState("down", "dev server stopped · press Restart");
    },
  };

  constructor(search: string) {
    super();
    this.params = new URLSearchParams(search);
    this.project = selectTemplate(this.params.get("template"));
    const requested = this.params.get("engine");
    if (requested !== null && !isEngine(requested)) throw new TypeError(`Unknown Bun engine: ${requested}`);
    this.engine = requested ?? DEFAULT_ENGINE;
    const profile = this.params.get("profile");
    this.profile = templateProfile(this.engine, this.project.id, profile === null ? undefined : parseMemoryProfile(profile));

    const mode = this.safeMode();
    const hasWebLocks = typeof navigator !== "undefined" && Boolean(navigator.locks);
    const hasBroadcastChannel = typeof BroadcastChannel === "function";
    this.attachEnabled = mode === "fast" && hasWebLocks && hasBroadcastChannel;
    const wsName = workspaceName(this.template);
    const previewRoute = this.attachEnabled ? `ws-${wsName}` : `mem-${this.tabId}`;
    this.previews = this.params.has("root-previews")
      ? new HostedPreviews(() => {
        if (!this.workspace) throw new Error("Sandbox runtime unavailable");
        return this.workspace.runtime;
      }, location.href, { managePageHide: false, deferBind: true })
      : new Previews({ baseURL: location.href, prefix: "__preview", route: previewRoute });

    this.disposePreviewRecovery = this.previews.onWorkerRecovered(() => {
      if (this.disposed) return;
      if (this.server?.token && this.isLivePreviewTarget(this.server)) {
        void this.showPreview(this.server, this.serverTiming.visibleStart).catch(this.report);
      }
    });
  }

  private safeMode(): ReturnType<typeof getVfsDescriptor>["mode"] | "invalid" {
    try { return getVfsDescriptor(this.params.get("mode") ?? "fast").mode; } catch { return "invalid"; }
  }

  get term(): Terminal | undefined { return this.termInstance; }
  get editor(): Editor | undefined { return this.editorMounted || this.workspace || this.ownershipLostFlag ? this.editorInstance : undefined; }

  get status(): Status {
    if (this.ownershipLostFlag || this.workspace?.fs.ownershipLost) return { text: `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`, kind: "error" };
    if (this.storageError) return { text: this.storageError, kind: "error" };
    return this.message;
  }

  private isWorkspaceUsable(ws: CoordinatorWorkspace | null): ws is WorkspaceRuntime {
    return (
      ws !== null &&
      !ws.runtime.disposed &&
      !ws.fs.ownershipLost &&
      ws.fs.state.status !== "failed" &&
      ws.fs.state.status !== "disposed" &&
      (!this.attachEnabled || ws.getIdentity() !== null)
    );
  }

  private hasRollbackFailure(): boolean {
    for (const s of this.provisioningState.values()) {
      if (s === "rollback-failed") return true;
    }
    return false;
  }

  private trackUnsettled(promise: Promise<void>): Promise<void> {
    return trackUnsettledPromise(promise, this.unsettledDisposals, this.terminalDisposalFailures);
  }

  private trackDurableWrite<T>(fn: () => Promise<T>): Promise<T> {
    let done!: () => void;
    const marker = new Promise<void>((res) => { done = res; });
    this.admittedPageWrites.add(marker);
    return fn().finally(() => {
      this.admittedPageWrites.delete(marker);
      done();
    });
  }

  private ensurePageUI(): void {
    if (!this.termInstance) {
      this.termInstance = createTerminal();
      this.termInstance.loadAddon(this.fit);
      linkLocalUrls(this.termInstance, this.previews);
    }
    if (!this.editorInstance) {
      this.editorInstance = new Editor({
        app: APP,
        readFile: (path, existingLease, signal) => this.readEditorFile(path, existingLease as ResetGateLease | undefined, signal),
        listFiles: (existingLease, signal) => this.listProjectFiles(existingLease as ResetGateLease | undefined, signal),
        save: (path, text, revision, editResetGen, options) => this.save(path, text, revision, editResetGen, options),
        checkpoint: (signal) => this.checkpointWorkspace(signal),
        currentResetGeneration: () => this.coordinator?.currentResetGeneration ?? 0,
        isResetting: () => this.resetting || this.localResetting || Boolean(this.coordinator?.hasActiveResetIntent()),
        changed: () => this.changed(),
      });
    }
  }

  private publishGlobalSandbox(): void {
    const api: Record<string, unknown> = {
      restart: () => this.restart(),
      dispose: () => this.teardown(),
      server: () => this.server,
      preview: () => this.preview,
      status: () => this.status,
      started: () => this.started,
      role: () => this.coordinator?.role ?? "local",
      engine: this.engine,
      profile: this.profile,
      template: this.template,
    };
    Object.defineProperties(api, {
      runtime: { get: () => this.workspace?.runtime, enumerable: true },
      sharedObjects: { get: () => this.workspace?.sharedObjects, enumerable: true },
      fs: { get: () => this.workspace?.fs, enumerable: true },
      editor: { get: () => this.editorMounted || this.workspace || this.ownershipLostFlag ? this.editorInstance : undefined, enumerable: true },
      term: { get: () => this.termInstance, enumerable: true },
      previews: { get: () => this.previews, enumerable: true },
    });
    Object.assign(globalThis, { sandbox: api });
  }

  private createWorkspaceRuntime(): WorkspaceRuntime {
    const mode = getVfsDescriptor(this.params.get("mode") ?? "fast").mode;
    const wsName = workspaceName(this.template);
    const fsWorker = entryAssetName("fs-worker.js");
    const workerInstanceId = crypto.randomUUID();
    const pageAlive = pageAliveLockName(wsName, this.tabId);

    let observer: WorkerIdentityObserver | null = null;
    let runtime: Runtime | null = null;
    let sharedObjects: ReturnType<typeof installBunSharedObjects> | null = null;
    let browserPrograms: BrowserPrograms | null = null;

    try {
      if (this.attachEnabled) {
        observer = createWorkerIdentityObserver(workerInstanceId, this.tabId, pageAlive);
      }
      const baseWorkerUrl = entryAssetUrl("./fs-worker.js");
      const workerURL = this.attachEnabled
        ? new URL(`${baseWorkerUrl.href}#attach:${workerInstanceId}`)
        : fsWorker !== "fs-worker.js"
          ? baseWorkerUrl
          : undefined;

      const filesystem = mode === "memory"
        ? { mode: "memory" as const, name: wsName, ...(workerURL ? { workerURL } : {}) }
        : {
          mode,
          name: wsName,
          ...(workerURL ? { workerURL } : {}),
          ...(this.attachEnabled ? { whenBusy: "attach" as const } : {}),
        };
      runtime = createRuntime({
        filesystem,
        memoryGroups: memoryGroupPolicy(this.engine, navigator.userAgent),
      });
      sharedObjects = installBunSharedObjects(runtime);
      const createdRuntime = runtime;
      browserPrograms = new BrowserPrograms(
        createdRuntime,
        {
          worker: entryAssetUrl("./preview1-worker.js"),
          shell: new URL("./programs/shell-engine.wasm", location.href),
          shellWorker: entryAssetUrl("./shell-worker.js"),
        },
        {
          runTransaction: (fn) => this.admitProvision(createdRuntime, fn),
          onStateChange: (state) => { this.provisioningState.set("base", state); },
        },
      );
      browserPrograms.preload();
      for (const pending of [createdRuntime.processes(), import("../../web/src/runner")]) pending.catch(() => {});

      const fs = createdRuntime.filesystem;
      fs.onOwnershipLost = () => {
        this.ownershipLostFlag = true;
        this.fail("startup", "");
        void this.teardown();
      };
      fs.onStateChange = (state) => {
        if (state.status === "disposed" && !this.intentionallyDisposedRuntimes.has(createdRuntime)) {
          void this.teardown();
        }
      };

      const moduleScope = registerModuleScope();
      const capturedObserver = observer;
      return {
        runtime: createdRuntime,
        fs,
        sharedObjects,
        browserPrograms,
        moduleScope,
        workerInstanceId,
        identityReady: capturedObserver?.identityReady ?? null,
        getIdentity: () => capturedObserver?.getIdentity() ?? null,
        getPartialWorkerIdentity: () => capturedObserver?.getPartialWorkerIdentity() ?? { workerClientId: null, peerAliveLock: null },
        disposeIdentityObserver: () => { try { capturedObserver?.dispose(); } catch {} },
        launchInvalidated: false,
      };
    } catch (error) {
      try { observer?.dispose(); } catch {}
      if (runtime === null && sharedObjects === null && browserPrograms === null) {
        if (this.workspace === null && this.provisionalReopen === null && this.unsettledDisposals.size === 0 && this.terminalDisposalFailures.length === 0) {
          this.runtimeRetiredCleanly = true;
        }
      } else {
        if (runtime) this.intentionallyDisposedRuntimes.add(runtime);
        this.runtimeRetiredCleanly = false;
        const r = runtime;
        const s = sharedObjects;
        const b = browserPrograms;
        const partialCleanup = Promise.allSettled([
          runCleanup(() => { s?.close(); }),
          runCleanup(() => r ? r.dispose() : Promise.resolve()),
          runCleanup(() => b ? b.dispose() : Promise.resolve()),
        ]).then((results) => {
          const errs = results
            .filter((res): res is PromiseRejectedResult => res.status === "rejected")
            .map((res) => res.reason);
          if (errs.length > 0) {
            throw errs.length === 1 ? errs[0] : new AggregateError(errs, "Partial workspace runtime cleanup failed");
          }
          if (this.workspace === null && this.provisionalReopen === null && this.terminalDisposalFailures.length === 0) {
            this.runtimeRetiredCleanly = true;
          }
        });
        this.trackUnsettled(partialCleanup);
      }
      throw error;
    }
  }

  private admitProvision<T>(runtime: Runtime, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (
      this.workspace?.runtime !== runtime ||
      runtime.disposed ||
      this.disposed ||
      this.teardownRequested ||
      this.runtimeRecycling !== null ||
      this.localResetting
    ) {
      return Promise.reject(new ProvisionAbortedError());
    }
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((res) => { resolveSettled = res; });
    const entry = { controller, settled };
    this.uncommittedProvisions.add(entry);
    const wsName = workspaceName(this.template);
    return (async () => {
      try {
        if (this.attachEnabled) {
          const ws = this.workspace;
          const identity = ws?.getIdentity() ?? null;
          if (!ws || ws.runtime !== runtime || !identity) {
            throw new ProvisionAbortedError("Worker identity unavailable");
          }
          return await withProvisionBinsLock(
            wsName,
            ws.fs,
            this.ownClaimIds,
            () => withWriterClaim(
              wsName,
              identity,
              this.ownClaimIds,
              () => fn(controller.signal),
              { signal: controller.signal },
            ),
            { signal: controller.signal },
          );
        }
        return await fn(controller.signal);
      } finally {
        this.uncommittedProvisions.delete(entry);
        resolveSettled();
      }
    })();
  }

  private async withAdmittedPageOp<T>(
    fn: (ws: WorkspaceRuntime, lease: ResetGateLease | undefined) => Promise<T>,
    options: { write: boolean; existingLease?: ResetGateLease; signal?: AbortSignal },
  ): Promise<T> {
    options.signal?.throwIfAborted();
    if (this.disposed || this.teardownRequested) throw new Error("Sandbox is disposed");
    if (options.write && this.localResetting) throw new ResetInProgressError();

    let lease = options.existingLease;
    let ownsLease = false;
    if (this.coordinator && !lease) {
      lease = await this.coordinator.enterResetGate({ forWrite: options.write, signal: options.signal });
      ownsLease = true;
      this.activePageResetLeases.add(lease);
    }

    try {
      if (this.runtimeRecycling) {
        await raceAbort(this.runtimeRecycling.promise, options.signal);
      }
      options.signal?.throwIfAborted();
      const ws = this.workspace;
      if (!ws || this.disposed || this.teardownRequested || ws.runtime.disposed) {
        throw new Error("Workspace runtime is unavailable");
      }
      if (options.write && this.localResetting) throw new ResetInProgressError();

      const set = options.write ? this.admittedPageWrites : this.admittedPageReads;
      let done!: () => void;
      const marker = new Promise<void>((res) => { done = res; });
      set.add(marker);
      try {
        return await fn(ws, lease);
      } finally {
        set.delete(marker);
        done();
      }
    } finally {
      if (ownsLease && lease) this.releasePageResetLease(lease);
    }
  }

  private releasePageResetLease(lease: ResetGateLease): void {
    this.activePageResetLeases.delete(lease);
    lease.release();
    if (this.activePageResetLeases.size > 0) return;
    const waiters = Array.from(this.ownGateIdleWaiters);
    this.ownGateIdleWaiters.clear();
    for (const cb of waiters) cb();
  }

  private waitForOwnResetGateIdle(): Promise<void> {
    if (this.activePageResetLeases.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.ownGateIdleWaiters.add(resolve);
    });
  }

  private async ensureTmpDir(ws: WorkspaceRuntime, lease: ResetGateLease | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.withAdmittedPageOp(
      async (liveWs) => {
        signal?.throwIfAborted();
        if (this.attachEnabled) {
          const identity = liveWs.getIdentity();
          if (!identity) throw new Error("Worker identity missing for ensureTmpDir");
          // Cancelable ONLY before acquiring claim / dispatching write; once dispatched, hold claim + lease until settled!
          const claim = await acquireWriterClaim(workspaceName(this.template), identity, this.ownClaimIds, { signal });
          try {
            await liveWs.fs.mkdirp("/tmp");
            await liveWs.fs.flush();
          } finally {
            await claim.release(performance.now() + 1_000).catch(() => {});
          }
        } else {
          await liveWs.fs.mkdirp("/tmp");
          await liveWs.fs.flush();
        }
      },
      { write: true, existingLease: lease, signal },
    );
  }

  private async readEditorFile(
    relPath: string,
    existingLease?: ResetGateLease,
    signal?: AbortSignal,
  ): Promise<{ text: string | null; resetGeneration: number }> {
    return this.withAdmittedPageOp(
      async (ws, lease) => {
        const gen = lease?.resetGeneration ?? this.coordinator?.currentResetGeneration ?? 0;
        const absPath = abs(relPath);
        if (signal) {
          signal.throwIfAborted();
          const client = new FilesystemClient(ws.fs.fork());
          const onAbort = () => { try { client.dispose(); } catch {} };
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            signal.throwIfAborted();
            const data = await client.asyncCall("readFile", [absPath]);
            signal.throwIfAborted();
            return { text: data ? decode(data) : null, resetGeneration: gen };
          } finally {
            signal.removeEventListener("abort", onAbort);
            try { client.dispose(); } catch {}
          }
        }
        const data = await ws.fs.readFile(absPath);
        return { text: data ? decode(data) : null, resetGeneration: gen };
      },
      { write: false, existingLease, signal },
    );
  }

  private async listProjectFiles(existingLease?: ResetGateLease, signal?: AbortSignal): Promise<string[]> {
    return this.withAdmittedPageOp(
      async (ws) => {
        if (signal) {
          signal.throwIfAborted();
          const paths = await raceAbort(ws.fs.listFiles(APP), signal);
          signal.throwIfAborted();
          return paths.map(rel).filter((p) => !p.split("/").some((part) => part.startsWith(".")));
        }
        return (await ws.fs.listFiles(APP)).map(rel).filter((p) => !p.split("/").some((part) => part.startsWith(".")));
      },
      { write: false, existingLease, signal },
    );
  }

  private async checkpointWorkspace(signal?: AbortSignal): Promise<void> {
    await this.withAdmittedPageOp(
      async (ws) => {
        await this.retryStorage(() => ws.fs.flush());
      },
      { write: true, signal },
    );
  }

  private startWorkspaceWatcher(ws: WorkspaceRuntime): WorkspaceWatchHandle {
    this.watch?.stop();
    const watch = startWorkspaceWatch({
      fs: ws.fs,
      targetPath: APP,
      onPaths: (paths) => this.handleWatchedPaths(paths),
      onReconcile: (reason) => this.handleWatchReconcile(reason),
    });
    this.watch = watch;
    return watch;
  }

  private handleWatchedPaths(paths: readonly string[]): void {
    if (this.disposed || this.resetting || this.localResetting || this.coordinator?.hasActiveResetIntent()) return;
    const meaningful = paths.filter((p) => !p.startsWith("node_modules/") && !p.split("/").some((part) => part.startsWith(".")));
    if (meaningful.length > 0) {
      if (this.refreshFilesThrottleTimer === null) {
        this.refreshFilesThrottleTimer = setTimeout(() => {
          this.refreshFilesThrottleTimer = null;
          void this.refreshFiles().catch(() => {});
        }, 200);
      }
      void this.editorInstance?.syncPaths(meaningful).catch(() => {});
    }
  }

  private async handleWatchReconcile(reason: ReconcileReason | "ui-reconcile"): Promise<void> {
    if (this.disposed || this.resetting || this.localResetting || this.coordinator?.hasActiveResetIntent()) return;
    await this.refreshFiles().catch(() => {});
    await this.editorInstance?.syncFromFs().catch(() => {});
    if (reason === "ui-reconcile") {
      if (this.serverState.state === "starting" && !this.run) {
        this.setServerState("down", "dev server stopped · press Restart");
      }
      return;
    }
    if (
      this.run !== null &&
      (reason === "fs-overflow" || reason === "recovered" || reason === "rebound")
    ) {
      if (this.coordinator && this.coordinator.role === "owner") {
        void this.coordinator.restartOwnedDevServer();
      } else if (!this.coordinator) {
        void this.startLocalDevServer().catch(this.report);
      }
    }
  }

  /** Builds the page's runtime, then starts the workspace and dev server in the background. */
  start(): void {
    if (this.startup) return;
    if (typeof addEventListener === "function") {
      addEventListener("pagehide", this.pagehideHandler);
    }
    try {
      const mode = getVfsDescriptor(this.params.get("mode") ?? "fast").mode;
      this.ensurePageUI();
      if (mode === "fast") {
        this.launchPersistent();
        return;
      }
      this.startWorkspace();
    } catch (error) { console.error(error); this.fail("construction", error); }
  }

  private startWorkspace(): void {
    try {
      this.workspace = this.createWorkspaceRuntime();
      this.editorMounted = true;
      if (this.previews instanceof HostedPreviews) this.previews.attachRuntime(this.workspace.runtime);
      this.publishGlobalSandbox();
    } catch (error) {
      console.error(error);
      this.fail("construction", error);
      return;
    }
    this.changed();
    const controller = new AbortController();
    const promise = this.boot(controller.signal).catch((error) => {
      if (controller.signal.aborted || this.disposed) return;
      this.fail("startup", error);
      this.report(error);
    }).finally(() => {
      if (this.provisionalBoot?.controller === controller) this.provisionalBoot = null;
    });
    this.provisionalBoot = { controller, promise };
  }

  private launchPersistent(): void {
    const controller = new AbortController();
    const pending = this.startPersistent(controller.signal).catch(error => {
      if (controller.signal.aborted || this.disposed) return;
      if (this.workspace?.fs.ownershipLost) {
        this.fail("startup", error);
      } else {
        this.failure = "storage";
        this.unreadable = !this.started && unreadableWorkspace(error, this.workspace?.fs.state);
        const action = this.canReloadStartup() ? "Retry reloads this page." : "Keep this page open and retry.";
        this.storageError = this.unreadable
          ? `This browser's saved copy of the workspace cannot be opened. Start fresh deletes it and opens the template again. ${errorText(error)}`
          : `Browser storage could not be opened or saved. Your workspace was kept. ${action} ${errorText(error)}`;
        if (!this.started || !this.server) {
          this.serverState = {
            state: "down",
            text: this.unreadable ? "saved workspace unreadable · press Start fresh" : "storage unavailable · press Retry",
          };
        }
        this.changed();
      }
      this.term?.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
    }).finally(() => {
      if (this.startup === pending) this.startup = undefined;
      if (this.provisionalBoot?.controller === controller) this.provisionalBoot = null;
    });
    this.startup = pending;
    this.provisionalBoot = { controller, promise: pending };
  }

  private initCoordinator(): DevServerCoordinator {
    if (this.coordinator) return this.coordinator;
    const scope = workspaceName(this.template);
    const coordinator = new DevServerCoordinator({
      scope,
      tabId: this.tabId,
      engine: this.engine,
      ownClaimIds: this.ownClaimIds,
      stopWaitMs: STOP_WAIT_MS,
      getWorkspace: () => this.workspace,
      isWorkspaceUsable: (ws) => this.isWorkspaceUsable(ws),
      isDisposed: () => this.disposed,
      isTeardownRequested: () => this.teardownRequested,
      hasActiveDevLaunchForCurrentWorkspace: () =>
        this.activeDevLaunch !== null &&
        this.workspace !== null &&
        this.activeDevLaunch.workspace === this.workspace &&
        this.activeDevLaunch.revision === this.serverRevision &&
        this.devClaimHandle !== null &&
        this.runtimeUsedForDev,
      getActiveDevWorkspace: () =>
        this.activeDevLaunch?.workspace ?? (this.devClaimHandle !== null || this.runtimeUsedForDev ? this.workspace : null),
      hasDevState: () => this.runtimeUsedForDev || this.devClaimHandle !== null || this.run !== null,
      hasRollbackFailure: () => this.hasRollbackFailure(),
      hasTerminalDisposalFailures: () => this.terminalDisposalFailures.length > 0,
      hasUnsettledDisposals: () => this.unsettledDisposals.size > 0,
      hasProvisionalReopen: () => this.provisionalReopen !== null,
      hasPendingDevClaim: () => this.pendingDevClaim !== null,
      hasActiveLaunchReservation: () => this.activeLaunchReservation !== null,
      hasUncommittedProvisions: () => this.uncommittedProvisions.size > 0,
      hasLifecycleTransition: () => this.lifecycleTransition !== null,
      joinPendingDevClaim: (sig) => this.pendingDevClaim ? raceAbort(this.pendingDevClaim.catch(() => {}), sig) : Promise.resolve(),
      joinUncommittedProvisions: (sig) =>
        this.uncommittedProvisions.size > 0
          ? raceAbort(Promise.allSettled(Array.from(this.uncommittedProvisions, (p) => p.settled)).then(() => {}), sig)
          : Promise.resolve(),
      joinLifecycleTransition: (sig) =>
        this.lifecycleTransition ? raceAbort(this.lifecycleTransition.catch(() => {}), sig) : Promise.resolve(),
      waitForOwnResetGateIdle: () => this.waitForOwnResetGateIdle(),
      retireRuntime: (opts) => this.retireRuntime(opts),
      launchDevServerAdmission: (attemptId, sig, onCommit) => this.launchDevServerAdmission(attemptId, sig, onCommit),
      repairBaseProgramsIfNeeded: async (sig) => {
        if (this.workspace && this.provisioningState.get("base") === "rollback-failed" && !this.run) {
          await raceAbort(this.workspace.browserPrograms.ready(), sig);
        }
      },
      clearOwnedPreview: () => {
        if (this.server?.helper && this.server.token) {
          this.previews.unregisterListener(this.server.port, this.server.token);
        }
        this.server = null;
        this.preview = null;
      },
      getCurrentOwnerState: () => {
        if (!this.serverState.state) return null;
        return {
          state: this.serverState.state,
          text: this.serverState.text,
          port: this.server?.port,
        };
      },
      readResetState: () => this.storage ? this.storage.readResetState() : Promise.resolve({ resetGeneration: 0, resetInProgress: false }),
      beginResetTransaction: () => this.storage ? this.storage.beginResetTransaction() : Promise.resolve(0),
      completeResetTransaction: () => this.storage ? this.storage.completeResetTransaction() : Promise.resolve(),
      fetchTemplateSources: (sig) => fetchTemplateSources(this.project.file, { signal: sig }),
      recoverInterruptedResetMutation: async (ws, sig, beforeFirstMutation) => {
        if (this.storage) {
          await restoreSource(ws.fs, this.storage.index, this.template, {
            signal: sig,
            beforeFirstMutation,
            createClient: (f) => new FilesystemClient(f.fork()),
          });
        }
        const files = await fetchTemplateSources(this.project.file, { signal: sig });
        await writeTemplateSources(ws.fs, APP, files, true, { beforeFirstMutation });
      },
      runCoordinatedResetMutation: async (ws, files) => {
        const replace = async () => {
          await ws.fs.mkdirp("/tmp");
          await writeTemplateSources(ws.fs, APP, files, true);
        };
        if (this.storage) await this.storage.reset(replace);
        else await replace();
      },
      trackDurableWrite: (fn) => this.trackDurableWrite(fn),
      ensureTmpDir: (ws, lease, sig) => this.ensureTmpDir(ws as WorkspaceRuntime, lease, sig),
      onWatchRebind: async (opts) => {
        if (this.disposed || this.teardownRequested) return;
        if (this.watch) {
          await this.watch.rebind(opts);
          return;
        }
        const ws = this.workspace;
        if (!ws || ws.runtime.disposed || ws.fs.ownershipLost) return;
        const fresh = this.startWorkspaceWatcher(ws);
        await raceAbort(fresh.ready, opts?.signal);
        if (opts?.reconcile && !opts.signal?.aborted && !this.disposed && !this.teardownRequested) {
          await this.handleWatchReconcile("rebound");
        }
      },
      onWatchAbort: () => {
        this.watch?.stop();
        this.watch = null;
      },
      onRefreshAndSync: async (lease, sig) => {
        await this.refreshFiles(lease, sig);
        await this.editorInstance?.syncFromFs(lease, sig);
      },
      onEditorSuspendAutosave: () => { this.editorInstance?.suspendAutosaveForReset(); },
      onEditorResumeAfterReset: () => { this.editorInstance?.resumeAfterReset(); },
      onEditorDiscard: () => { this.editorInstance?.discard(); },
      onResetCommittedReload: () => { location.reload(); },
      onObservedOwnerState: (state) => this.handleObservedOwnerState(state),
      onObservedOwnerStopping: () => {
        this.preview = null;
        this.server = null;
        this.setServerState("starting", "switching dev server owner…");
      },
      onFrozenOwnerDetected: () => {
        this.preview = null;
        this.server = null;
        this.setServerState("down", "dev server tab paused · waiting for it to resume or close");
        this.setStatus("shared workspace live · dev server tab is paused (edits still sync)");
      },
      onRoleChange: () => { this.changed(); },
      onReport: (msg, err) => {
        if (err) this.report(err);
        else this.setStatus(msg, "error");
      },
    });
    this.coordinator = coordinator;
    return coordinator;
  }

  private async startPersistent(signal: AbortSignal): Promise<void> {
    const engine = this.wasm ? Promise.resolve() : this.loadEngine();
    this.setStatus("checking stored projects…");
    this.storage ??= await WorkspaceStorage.open({
      stored: () => storedWorkspaces("fast"),
      openIdle: (name, sig) => openIdleWorkspace({ mode: "fast", name }, { signal: sig }),
    }, this.template, report => this.storageResult(report));
    stage("storage-open");
    await this.storage.prepare();
    stage("storage-prepared");

    if (this.attachEnabled) {
      const wsName = workspaceName(this.template);
      if (!this.presenceLock) {
        this.presenceLock = await acquireLockHandle(presenceLockName(wsName), { mode: "shared", signal });
      }
      if (!this.pageAliveLock) {
        this.pageAliveLock = await acquireLockHandle(pageAliveLockName(wsName, this.tabId), { mode: "exclusive", signal });
      }
      this.initCoordinator();
    }

    if (!this.workspace) {
      this.workspace = this.createWorkspaceRuntime();
      this.editorMounted = true;
      if (this.previews instanceof HostedPreviews) this.previews.attachRuntime(this.workspace.runtime);
      this.publishGlobalSandbox();
    }
    this.changed();
    await this.boot(signal, engine);
  }

  private storageResult(report: EvictionReport): void {
    this.storageNotice = report.kept.map(item => {
      const label = item.template === this.project.id ? this.project.label : item.template;
      const reason = item.error instanceof DOMException ? `${item.error.name}${item.error.message ? `: ${item.error.message}` : ""}` : errorText(item.error);
      return `${label}: ${reason}`;
    }).join("; ");
    if (this.storageNotice) this.storageNotice = `Some idle installs were kept. ${this.storageNotice}`;
    this.changed();
  }

  openTerminal(term: Terminal, node: HTMLElement, signal: AbortSignal): void {
    openTerminal(term, this.fit, node, signal);
    this.terminalOpened();
  }

  attachPreview(frame: HTMLIFrameElement): void {
    this.frame = frame;
  }

  /** Lists the project again for the file tree and file menu. Dotfiles stay hidden. */
  async refreshFiles(existingLease?: ResetGateLease, signal?: AbortSignal): Promise<void> {
    if (!this.workspace || this.disposed) return;
    const revision = ++this.filesRevision;
    const paths = await this.listProjectFiles(existingLease, signal);
    if (revision !== this.filesRevision || signal?.aborted || this.disposed) return;
    this.files = paths;
    this.changed();
  }

  /** Flushes debounced edits before leaving; a failed save keeps this page open. */
  async navigate(param: "engine" | "template", value: string): Promise<void> {
    await this.editorInstance?.flushAll();
    if (this.editorInstance?.hasUnsavedChanges()) {
      throw new Error("Save or resolve unsaved editor changes before switching engine or template.");
    }
    await this.teardown();
    const next = new URL(location.href);
    const fallback = param === "engine" ? DEFAULT_ENGINE : defaultTemplate.id;
    if (value === fallback) next.searchParams.delete(param);
    else next.searchParams.set(param, value);
    if (param === "engine") next.searchParams.delete("wasm");
    location.assign(next);
  }

  restart(): void {
    if (this.failure === "storage") {
      if (this.startup) return;
      if (this.unreadable) { location.reload(); return; }
      if (!this.started && this.workspace?.fs.state.status === "failed") {
        if (this.canReloadStartup()) location.reload();
        return;
      }
      this.failure = undefined;
      if (!this.started) this.serverState = { state: "starting", text: "starting…" };
      if (!this.started && getVfsDescriptor(this.params.get("mode") ?? "fast").mode === "fast") this.launchPersistent();
      else if (!this.started) this.startWorkspace();
      else if (this.coordinator) void this.coordinator.requestRestartOrHandover();
      else void this.startLocalDevServer().catch(this.report);
      return;
    }
    if (this.failure) { location.reload(); return; }
    if (!this.started || this.resetting || this.localResetting) return;
    this.term?.write("\r\n");
    if (this.coordinator) {
      void this.coordinator.requestRestartOrHandover().then((res) => {
        if (!res.ok && res.error) this.setStatus(res.error, "error");
      });
    } else {
      void this.startLocalDevServer().catch(this.report);
    }
  }

  private canReloadStartup(): boolean {
    const workspace = this.workspace;
    const editor = this.editorInstance;
    return !this.started && !!workspace && workspace.fs.state.status === "failed"
      && (!editor || (editor.path === "" && !editor.hasPending && editor.view.state.doc.length === 0));
  }

  /** Deletes a workspace that cannot be opened, then reloads into a fresh one. */
  async startFresh(): Promise<void> {
    if (!this.unreadable || this.resetting) return;
    this.resetting = true;
    this.changed();
    try {
      const result = await startFresh(() => this.teardown(), workspaceName(this.template));
      if (result !== "busy") { location.reload(); return; }
      this.storageError = START_FRESH_BUSY;
    } catch (error) {
      this.storageError = `Start fresh failed. ${errorText(error)}`;
    }
    this.resetting = false;
    this.changed();
  }

  async reset(): Promise<void> {
    if (this.disposed || this.teardownRequested) return;
    if (this.coordinator) {
      if (this.resetting) return;
      this.resetting = true;
      this.changed();
      try {
        await this.coordinator.resetWorkspace();
      } finally {
        this.resetting = false;
        this.changed();
      }
      return;
    }

    // Local uncoordinated Reset template (mode=memory OR single-tab persistent fallback).
    if (!this.workspace || this.resetting || this.localResetting) return;
    this.localResetting = true;
    this.resetting = true;
    this.serverRevision++;
    this.stopDevServer();
    this.editorInstance?.suspendAutosaveForReset();
    this.changed();

    const deadline = performance.now() + STOP_WAIT_MS;
    const resetAbort = new AbortController();
    const timer = setTimeout(() => resetAbort.abort(new DOMException("Reset timed out", "AbortError")), STOP_WAIT_MS);
    try {
      // Wait for any already-stopped guest runs first without disposing the old runtime.
      if (this.stopping.size > 0) {
        await Promise.allSettled(Array.from(this.stopping, (s) => s.ended));
      }
      if (this.disposed || this.teardownRequested) return;
      // Pre-fetch & validate replacement template BEFORE disposing the old runtime.
      let files: TemplateSources;
      try {
        files = await fetchTemplateSources(this.project.file, { signal: resetAbort.signal });
      } catch (error) {
        this.localResetting = false;
        this.resetting = false;
        this.editorInstance?.resumeAfterReset();
        this.report(error);
        this.changed();
        return;
      }

      const retired = await this.retireRuntime({
        mode: "reopen",
        timeoutMs: Math.max(1, deadline - performance.now()),
      });
      if (!retired.ok) {
        this.localResetting = false;
        this.resetting = false;
        if (this.workspace && !this.workspace.runtime.disposed) {
          this.editorInstance?.resumeAfterReset();
        }
        this.report(new Error("Reset failed to retire runtime cleanly"));
        this.changed();
        return;
      }

      if (this.disposed || this.teardownRequested || !this.workspace) return;
      const ws = this.workspace;
      try {
        await this.trackDurableWrite(async () => {
          const replace = async () => {
            await ws.fs.mkdirp("/tmp");
            await writeTemplateSources(ws.fs, APP, files, true);
          };
          if (this.storage) await this.storage.reset(replace);
          else await replace();
        });
      } catch (error) {
        if (this.disposed || this.teardownRequested) return;
        this.editorInstance?.invalidatePendingLoads();
        this.editorInstance?.markAllOpenConflicted();
        this.localResetting = false;
        this.resetting = false;
        if (this.workspace && !this.workspace.runtime.disposed) {
          this.editorInstance?.resumeAfterReset();
          void this.refreshFiles().catch(() => {});
        }
        this.report(error);
        this.changed();
        return;
      }

      if (this.disposed || this.teardownRequested) return;
      this.editorInstance?.discard();
      if (this.storage) {
        location.reload();
        return;
      }
      this.localResetting = false;
      this.resetting = false;
      this.editorInstance?.resumeAfterReset();
      this.changed();
      await this.refreshFiles();
      const startFile = this.project.editorFile;
      const openTarget = (await ws.fs.lookup(abs(startFile))) ? startFile : ((await ws.fs.listFiles(APP)).map(rel)[0] ?? startFile);
      await this.editorInstance?.open(openTarget);
      if (this.wasm) void this.startLocalDevServer().catch(this.report);
    } finally {
      clearTimeout(timer);
    }
  }

  readonly report = (error: unknown): void => {
    if (isStorageFull(error) || error instanceof PreservationRefused) {
      this.failure = "storage";
      this.storageError = `Browser storage could not be saved. Keep this page open and copy any unsaved text. No active project was removed. ${errorText(error)}`;
    }
    if (!this.server) {
      this.serverState = {
        state: "down",
        text: this.failure === "storage" ? "storage unavailable · press Retry" : "startup failed · press Restart",
      };
    }
    this.setStatus(errorText(error), "error");
    this.term?.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
  };

  private changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  private setStatus(text: string, kind: Status["kind"] = ""): void {
    performance.mark("bunwasm:status", { detail: text });
    this.message = { text, kind };
    this.changed();
  }

  private fail(failure: Failure, error: unknown): void {
    this.failure = failure;
    const lost = this.ownershipLostFlag || this.workspace?.fs.ownershipLost;
    if (lost) this.stopDevServer();
    if (!this.started || lost || !this.server) {
      this.serverState = {
        state: "down",
        text: lost
          ? "workspace open in another tab · press Reload"
          : "startup failed · press Reload",
      };
    }
    this.setStatus(errorText(error), "error");
  }

  private setServerState(state: NonNullable<ServerState["state"]>, text: string, url?: string): void {
    this.serverState = { state, text, url };
    if (url) this.previewLink = url;
    this.changed();
  }

  private async boot(signal: AbortSignal, engine = this.loadEngine()): Promise<void> {
    await this.terminalOpen;
    stage("terminal-open");
    signal.throwIfAborted();
    const ws = this.workspace;
    if (!ws) throw new Error("Workspace runtime not constructed");

    if (this.attachEnabled && ws.identityReady) {
      await Promise.all([
        raceAbort(ws.identityReady, signal),
        probeFilesystemReady(ws.fs, signal),
      ]);
      signal.throwIfAborted();
    }

    this.setServerState("starting", "loading…");
    if (!globalThis.crossOriginIsolated) {
      this.setStatus("this page is not cross-origin isolated: the dev server can't serve previews", "error");
    }

    if (this.attachEnabled && this.coordinator) {
      await this.bootAttached(signal, engine);
      return;
    }

    // Uncoordinated local boot (mode=memory OR single-tab persistent fallback).
    await this.retryStorage(() => ws.fs.mkdirp("/tmp"));
    stage("filesystem-open");
    const seed = () => loadTemplate(ws.fs, APP, this.project.file, false, { signal }).then(() => {});
    const initialize = this.storage ? () => this.storage!.initialize(ws.fs, seed, { signal }) : seed;
    await Promise.all([
      this.retryStorage(async () => {
        await initialize();
        await upgradeReactRouterPreviewMount(ws.fs, APP);
      }).then(() => stage("workspace-ready")),
      engine,
    ]);
    this.storageError = "";
    if (this.resetting || this.disposed || signal.aborted) return;
    await this.refreshFiles(undefined, signal);
    const startFile = this.project.editorFile;
    await this.editorInstance!.open(
      (await ws.fs.lookup(abs(startFile))) ? startFile : ((await ws.fs.listFiles(APP)).map(rel)[0] ?? startFile),
      undefined,
      signal,
    );
    stage("editor-open");
    this.workspaceInitialized = true;
    if (!this.failure) this.started = true;
    this.startup = undefined;
    this.changed();
    if (!this.wasm) return;
    this.setStatus(`starting the dev server on ${ENGINES[this.engine].name}…`);
    await this.startLocalDevServer();
  }

  private disposeWorkspaceBundle(
    target: WorkspaceRuntime,
    options: { releaseDevClaim: boolean; rollbackFailed: boolean },
  ): Promise<void> {
    this.intentionallyDisposedRuntimes.add(target.runtime);
    target.disposeIdentityObserver();
    const p0 = runCleanup(() => { target.sharedObjects.close(); });
    const p1 = runCleanup(() => target.runtime.dispose());
    const p2 = runCleanup(() => target.browserPrograms.dispose());
    const bundle = Promise.allSettled([p0, p1, p2]).then(async (results) => {
      const errs = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason);
      if (errs.length > 0) {
        throw errs.length === 1 ? errs[0] : new AggregateError(errs, "Runtime disposal failed");
      }
      if (options.rollbackFailed || this.terminalDisposalFailures.length > 0) {
        this.runtimeRetiredCleanly = false;
        return;
      }
      if (options.releaseDevClaim) {
        const handle = this.devClaimHandle;
        this.devClaimHandle = null;
        await handle?.release(performance.now() + STOP_WAIT_MS);
        this.runtimeUsedForDev = false;
      }
      if (this.workspace === null && this.provisionalReopen === null && this.terminalDisposalFailures.length === 0) {
        this.runtimeRetiredCleanly = true;
      }
    });
    return this.trackUnsettled(bundle);
  }

  private async bootAttached(signal: AbortSignal, engine: Promise<void>): Promise<void> {
    const coordinator = this.coordinator!;
    const wsName = workspaceName(this.template);
    while (true) {
      signal.throwIfAborted();
      let bootLease: ResetGateLease | null = null;
      let provLiveWriters: LockHandle | null = null;
      let provWatch: WorkspaceWatchHandle | null = null;
      try {
        bootLease = await coordinator.enterResetGate({ signal });
        const liveWs = this.workspace!;
        const identity = liveWs.getIdentity()!;
        await withProvisionSeedLock(
          wsName,
          liveWs.fs,
          this.ownClaimIds,
          async () => {
            await this.ensureTmpDir(liveWs, bootLease!, signal);
            stage("filesystem-open");
            await withExclusiveLiveWriters(
              wsName,
              liveWs.fs,
              this.ownClaimIds,
              async () => {
                await withWriterClaim(
                  wsName,
                  identity,
                  this.ownClaimIds,
                  async () => {
                    const seed = () => loadTemplate(liveWs.fs, APP, this.project.file, false, { signal }).then(() => {});
                    const initialize = this.storage
                      ? () => this.storage!.initialize(liveWs.fs, seed, { signal })
                      : seed;
                    await this.retryStorage(initialize);
                    await upgradeReactRouterPreviewMount(liveWs.fs, APP);
                  },
                  { signal },
                );
              },
              { signal },
            );
          },
          { signal, onWaiting: () => this.setStatus("waiting for workspace setup in another tab…") },
        );
        stage("workspace-ready");

        provLiveWriters = await acquireLockHandle(liveWritersLockName(wsName), { mode: "shared", signal });
        provWatch = this.startWorkspaceWatcher(liveWs);
        await raceAbort(provWatch.ready, signal);

        await this.openBootEditor(liveWs, bootLease, engine, signal);
        if (this.disposed || this.teardownRequested || signal.aborted || coordinator.hasActiveResetIntent()) {
          throw new ResetInProgressError();
        }

        const liveWriters = provLiveWriters;
        this.releaseLiveWriters = liveWriters ? () => liveWriters.release() : null;
        provLiveWriters = null;
        provWatch = null;
        this.storageError = "";
        this.workspaceInitialized = true;
        if (!this.failure) this.started = true;
        this.startup = undefined;
        this.changed();
        break;
      } catch (error) {
        provWatch?.stop();
        provLiveWriters?.release();
        bootLease?.release();
        bootLease = null;
        if (!(error instanceof ResetInProgressError) || signal.aborted || this.disposed || this.teardownRequested) {
          throw error;
        }
        await coordinator.waitForPendingResets(signal);
      } finally {
        bootLease?.release();
      }
    }

    if (!this.wasm || this.disposed) return;
    coordinator.start();
    this.setStatus(`starting the dev server on ${ENGINES[this.engine].name}…`);
    await coordinator.attemptElection();
  }

  private async openBootEditor(
    liveWs: WorkspaceRuntime,
    bootLease: ResetGateLease,
    engine: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.all([this.refreshFiles(bootLease, signal), engine]);
    const startFile = this.project.editorFile;
    const openTarget = (await liveWs.fs.lookup(abs(startFile)))
      ? startFile
      : ((await this.listProjectFiles(bootLease, signal))[0] ?? startFile);
    await this.editorInstance!.open(openTarget, bootLease, signal);
    stage("editor-open");
  }

  private async awaitBoundWithSignal<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal) {
    return withDeadline(signal ? raceAbort(promise, signal) : promise, deadline);
  }

  private shouldSkipReopenOnlyIfUnusable(options: RetireOptions): boolean {
    return (
      options.mode === "reopen" &&
      options.onlyIfUnusable === true &&
      this.isWorkspaceUsable(this.workspace) &&
      !this.workspace.launchInvalidated &&
      !this.hasRollbackFailure() &&
      this.unsettledDisposals.size === 0 &&
      this.provisionalReopen === null &&
      this.terminalDisposalFailures.length === 0
    );
  }

  private async confirmRetireStart(options: RetireOptions, deadline: number, reopenSignal?: AbortSignal): Promise<boolean> {
    if (options.mode !== "teardown" && (this.teardownRequested || this.disposed || (options.shouldBegin && !options.shouldBegin()))) {
      return false;
    }
    if (reopenSignal?.aborted) return false;
    if (options.mode === "teardown" || !options.confirmBegin) return true;
    const confirmed = await this.awaitBoundWithSignal(options.confirmBegin(reopenSignal), deadline, reopenSignal);
    return (
      !reopenSignal?.aborted &&
      !confirmed.timedOut &&
      !confirmed.rejected &&
      Boolean(confirmed.value) &&
      !this.teardownRequested &&
      !this.disposed &&
      (!options.shouldBegin || options.shouldBegin())
    );
  }

  private async drainPendingActivities(
    options: RetireOptions,
    deadline: number,
    reopenSignal?: AbortSignal,
  ): Promise<{ ok: true; cleanupFailed: boolean } | { ok: false; result: RetireResult }> {
    const pendingDrain = Promise.allSettled([
      ...Array.from(this.localStartupPhases, (p) => p.done),
      ...Array.from(this.admittedPageWrites),
    ]);
    const drainRes = await this.awaitBoundWithSignal(pendingDrain, deadline, reopenSignal);
    if (reopenSignal?.aborted) return { ok: false, result: { ok: false, reason: "other" } };
    if (drainRes.timedOut) return { ok: false, result: { ok: false, reason: "pending-settlement", pending: pendingDrain } };

    if (options.mode === "reopen") {
      const pendingReads = Promise.allSettled(Array.from(this.admittedPageReads));
      const readRes = await this.awaitBoundWithSignal(pendingReads, deadline, reopenSignal);
      if (reopenSignal?.aborted) return { ok: false, result: { ok: false, reason: "other" } };
      if (readRes.timedOut) return { ok: false, result: { ok: false, reason: "pending-settlement", pending: pendingReads } };
    }

    const pendingProvisions = Promise.allSettled(Array.from(this.uncommittedProvisions, (p) => p.settled));
    const provRes = await this.awaitBoundWithSignal(pendingProvisions, deadline, reopenSignal);
    if (reopenSignal?.aborted) return { ok: false, result: { ok: false, reason: "other" } };
    if (provRes.timedOut) return { ok: false, result: { ok: false, reason: "pending-settlement", pending: pendingProvisions } };

    let cleanupFailed = false;
    if (this.hasRollbackFailure()) {
      if (options.mode === "reopen") return { ok: false, result: { ok: false, reason: "other" } };
      cleanupFailed = true;
    }

    if (this.pendingDevClaim) {
      const pendingClaim = this.pendingDevClaim.catch(() => {});
      const claimRes = await this.awaitBoundWithSignal(pendingClaim, deadline, reopenSignal);
      if (reopenSignal?.aborted) return { ok: false, result: { ok: false, reason: "other" } };
      if (claimRes.timedOut) return { ok: false, result: { ok: false, reason: "pending-settlement", pending: pendingClaim } };
    }

    return { ok: true, cleanupFailed };
  }

  private async settleTeardownHostedPreviews(deadline: number): Promise<RetireResult | null> {
    if (
      !(this.previews instanceof HostedPreviews) ||
      this.previews.hasActiveConsumer() ||
      this.unsettledDisposals.size > 0 ||
      this.terminalDisposalFailures.length > 0
    ) {
      return null;
    }
    const prevRes = await withDeadline(this.trackUnsettled(this.previews.dispose()), deadline);
    if (!prevRes.timedOut) return null;
    return { ok: false, reason: "pending-settlement", pending: Promise.allSettled(Array.from(this.unsettledDisposals)) };
  }

  private async drainUnsettledDisposals(deadline: number, reopenSignal?: AbortSignal): Promise<RetireResult | null> {
    if (this.unsettledDisposals.size === 0) return null;
    const all = Promise.allSettled(Array.from(this.unsettledDisposals));
    const res = await this.awaitBoundWithSignal(all, deadline, reopenSignal);
    if (reopenSignal?.aborted) return { ok: false, reason: "other" };
    if (res.timedOut || this.unsettledDisposals.size > 0) {
      return { ok: false, reason: "pending-settlement", pending: Promise.allSettled(Array.from(this.unsettledDisposals)) };
    }
    return null;
  }

  private async disposeCurrentOrStaleWorkspace(
    options: RetireOptions,
    cleanupFailed: boolean,
    deadline: number,
    reopenSignal?: AbortSignal,
  ): Promise<{ done: true; result: RetireResult; disposalStarted: boolean } | { done: false; disposalStarted: boolean }> {
    if (this.workspace === null) {
      if (this.provisionalReopen !== null) {
        const stale = this.provisionalReopen;
        this.provisionalReopen = null;
        const staleRes = await this.awaitBoundWithSignal(
          this.disposeWorkspaceBundle(stale, { releaseDevClaim: false, rollbackFailed: false }),
          deadline,
          reopenSignal,
        );
        if (reopenSignal?.aborted) return { done: true, result: { ok: false, reason: "other" }, disposalStarted: false };
        if (staleRes.timedOut) {
          return { done: true, result: { ok: false, reason: "pending-settlement", pending: Promise.allSettled(Array.from(this.unsettledDisposals)) }, disposalStarted: false };
        }
      }
      if (options.mode === "reopen") return { done: false, disposalStarted: false };
      const pending = await this.drainUnsettledDisposals(deadline);
      if (pending) return { done: true, result: pending, disposalStarted: false };
      if (options.mode === "teardown") {
        const prevPending = await this.settleTeardownHostedPreviews(deadline);
        if (prevPending) return { done: true, result: prevPending, disposalStarted: false };
      }
      const ok = !cleanupFailed && this.runtimeRetiredCleanly && this.terminalDisposalFailures.length === 0 && this.provisionalReopen === null;
      return { done: true, result: ok ? { ok: true } : { ok: false, reason: "other" }, disposalStarted: false };
    }

    if (
      options.mode === "reopen" &&
      (reopenSignal?.aborted || this.teardownRequested || this.disposed || (options.shouldBegin && !options.shouldBegin()))
    ) {
      return { done: true, result: { ok: false, reason: "other" }, disposalStarted: false };
    }
    const retiring = this.workspace;
    this.workspace = null;
    this.runtimeRetiredCleanly = false;
    this.editorInstance?.invalidatePendingLoads();
    const dispRes = await this.awaitBoundWithSignal(
      this.disposeWorkspaceBundle(retiring, { releaseDevClaim: true, rollbackFailed: cleanupFailed }),
      deadline,
      reopenSignal,
    );
    if (reopenSignal?.aborted) return { done: true, result: { ok: false, reason: "other" }, disposalStarted: true };
    if (dispRes.timedOut) {
      return { done: true, result: { ok: false, reason: "pending-settlement", pending: Promise.allSettled(Array.from(this.unsettledDisposals)) }, disposalStarted: true };
    }
    if (dispRes.rejected) return { done: true, result: { ok: false, reason: "other" }, disposalStarted: true };

    if (options.mode === "teardown") {
      const prevPending = await this.settleTeardownHostedPreviews(deadline);
      if (prevPending) return { done: true, result: prevPending, disposalStarted: true };
    }
    if (options.mode !== "reopen") {
      const pending = await this.drainUnsettledDisposals(deadline);
      if (pending) return { done: true, result: pending, disposalStarted: true };
      const ok = !cleanupFailed && this.runtimeRetiredCleanly && this.terminalDisposalFailures.length === 0;
      return { done: true, result: ok ? { ok: true } : { ok: false, reason: "other" }, disposalStarted: true };
    }
    if (this.teardownRequested || this.disposed) return { done: true, result: { ok: false, reason: "other" }, disposalStarted: true };
    return { done: false, disposalStarted: true };
  }

  private async openProvisionalWorkspace(
    options: RetireOptions,
    deadline: number,
    reopenSignal?: AbortSignal,
  ): Promise<RetireResult> {
    if (this.terminalDisposalFailures.length > 0) return { ok: false, reason: "other" };
    const unsettled = await this.drainUnsettledDisposals(deadline, reopenSignal);
    if (unsettled) return unsettled;
    if (
      this.teardownRequested ||
      this.disposed ||
      reopenSignal?.aborted ||
      (options.shouldReopen && !options.shouldReopen()) ||
      this.terminalDisposalFailures.length > 0 ||
      this.provisionalReopen !== null
    ) {
      return { ok: false, reason: "other" };
    }

    let provisional: WorkspaceRuntime;
    try {
      provisional = this.createWorkspaceRuntime();
    } catch {
      return { ok: false, reason: "other" };
    }
    this.provisionalReopen = provisional;

    const setupPromise = Promise.all([
      probeFilesystemReady(provisional.fs, reopenSignal),
      this.attachEnabled && provisional.identityReady ? raceAbort(provisional.identityReady, reopenSignal) : Promise.resolve(),
    ]);
    const setupRes = await this.awaitBoundWithSignal(setupPromise, deadline, reopenSignal);

    if (
      setupRes.timedOut ||
      setupRes.rejected ||
      !this.isWorkspaceUsable(provisional) ||
      this.teardownRequested ||
      this.disposed ||
      reopenSignal?.aborted ||
      (options.shouldReopen && !options.shouldReopen())
    ) {
      this.provisionalReopen = null;
      this.disposeWorkspaceBundle(provisional, { releaseDevClaim: false, rollbackFailed: false });
      return { ok: false, reason: "other" };
    }

    this.workspace = provisional;
    this.editorMounted = true;
    this.provisionalReopen = null;
    this.runtimeRetiredCleanly = false;
    if (this.previews instanceof HostedPreviews) this.previews.attachRuntime(provisional.runtime);
    if (this.attachEnabled) this.startWorkspaceWatcher(provisional);
    return { ok: true };
  }

  private restoreWatchIfUnretired(initialWorkspace: WorkspaceRuntime | null, watchAborted: boolean, disposalStarted: boolean, adoptedFresh: boolean): void {
    if (
      !watchAborted ||
      disposalStarted ||
      adoptedFresh ||
      this.disposed ||
      this.teardownRequested ||
      initialWorkspace === null ||
      this.workspace !== initialWorkspace ||
      initialWorkspace.runtime.disposed
    ) {
      return;
    }
    if (this.attachEnabled) this.startWorkspaceWatcher(initialWorkspace);
    void this.handleWatchReconcile("ui-reconcile");
  }

  /** Serialized, pre-queue bounded runtime retirement & read-only provisional reopen (§5.2). */
  async retireRuntime(options: RetireOptions): Promise<RetireResult> {
    const deadline = performance.now() + options.timeoutMs;
    if (options.mode === "teardown") this.teardownRequested = true;

    while (this.lifecycleTransition) {
      const previous = this.lifecycleTransition;
      const reopenSig = options.mode === "reopen" ? options.signal : undefined;
      const waited = await this.awaitBoundWithSignal(previous.catch(() => {}), deadline, reopenSig);
      if (reopenSig?.aborted) return { ok: false, reason: "other" };
      if (waited.timedOut) return { ok: false, reason: "pending-settlement", pending: previous.catch(() => {}) };
    }

    let releaseSlot!: () => void;
    const slotPromise = new Promise<void>((res) => { releaseSlot = res; });
    this.lifecycleTransition = slotPromise;

    try {
      const reopenSignal = options.mode === "reopen" ? options.signal : undefined;
      if (!(await this.confirmRetireStart(options, deadline, reopenSignal))) return { ok: false, reason: "other" };
      if (this.shouldSkipReopenOnlyIfUnusable(options)) return { ok: true };

      const initialWorkspace = this.workspace;
      let watchAborted = false;
      let disposalStarted = false;
      let adoptedFreshWorkspace = false;
      let resolveRecycling!: () => void;
      const recyclingPromise = new Promise<void>((res) => { resolveRecycling = res; });
      this.runtimeRecycling = { promise: recyclingPromise, resolve: resolveRecycling };

      try {
        this.serverRevision++;
        this.activeDevLaunch = null;
        if (this.workspace) this.workspace.launchInvalidated = true;
        this.stopDevServer();
        this.server = null;
        if (this.coordinator?.restartLaunchController && this.coordinator.restartLaunchController.signal !== options.signal) {
          this.coordinator.restartLaunchController.abort();
        }
        this.activeLaunchReservation = null;
        if (this.watch) {
          this.watch.stop();
          this.watch = null;
          watchAborted = true;
        }
        for (const phase of this.localStartupPhases) phase.controller.abort();
        for (const prov of this.uncommittedProvisions) prov.controller.abort();

        const drained = await this.drainPendingActivities(options, deadline, reopenSignal);
        if (!drained.ok) return drained.result;

        const disposed = await this.disposeCurrentOrStaleWorkspace(options, drained.cleanupFailed, deadline, reopenSignal);
        disposalStarted = disposed.disposalStarted;
        if (disposed.done) return disposed.result;

        const opened = await this.openProvisionalWorkspace(options, deadline, reopenSignal);
        if (opened.ok) adoptedFreshWorkspace = true;
        return opened;
      } finally {
        const rec = this.runtimeRecycling;
        this.runtimeRecycling = null;
        rec?.resolve();
        if (options.mode === "reopen") {
          this.restoreWatchIfUnretired(initialWorkspace, watchAborted, disposalStarted, adoptedFreshWorkspace);
        }
      }
    } finally {
      if (this.lifecycleTransition === slotPromise) this.lifecycleTransition = null;
      releaseSlot();
    }
  }

  private async tryPublishDevAdmission(
    attemptId: string,
    revision: number,
    reservation: { attemptId: string; revision: number },
    workspaceRecord: WorkspaceRuntime,
    runtime: Runtime,
    claim: WriterClaimHandle,
    signal: AbortSignal | undefined,
    onCommit?: () => void,
  ): Promise<boolean> {
    const pendingReset = await this.coordinator!.syncPendingResetLocks(signal);
    const canPublish =
      !pendingReset &&
      this.activeLaunchReservation === reservation &&
      this.coordinator?.currentAttemptId === attemptId &&
      this.coordinator?.role === "owner" &&
      !signal?.aborted &&
      !this.disposed &&
      !this.teardownRequested &&
      this.runtimeRecycling === null &&
      this.workspace === workspaceRecord &&
      this.workspace.runtime === runtime &&
      this.isWorkspaceUsable(workspaceRecord) &&
      !workspaceRecord.launchInvalidated &&
      revision === this.serverRevision &&
      !this.coordinator.hasActiveResetIntent();
    if (!canPublish) {
      if (this.activeLaunchReservation === reservation) this.activeLaunchReservation = null;
      return false;
    }
    this.devClaimHandle = claim;
    this.runtimeUsedForDev = true;
    this.activeDevLaunch = { attemptId, workspace: workspaceRecord, revision };
    this.activeLaunchReservation = null;
    onCommit?.();
    void this.runDevServerLoop(revision, workspaceRecord);
    return true;
  }

  private async launchDevServerAdmission(
    attemptId: string,
    signal?: AbortSignal,
    onCommit?: () => void,
  ): Promise<void> {
    if (this.activeLaunchReservation !== null || this.devClaimHandle !== null || this.runtimeUsedForDev) {
      throw new LaunchCancelledError();
    }
    const workspaceRecord = this.workspace;
    const runtime = workspaceRecord?.runtime;
    const revision = this.serverRevision;
    const reservation = { attemptId, revision };
    this.activeLaunchReservation = reservation;

    let admissionPromise!: Promise<void>;
    admissionPromise = (async () => {
      let claim: WriterClaimHandle | null = null;
      let published = false;
      const wsName = workspaceName(this.template);
      const lockNames = coordinatorLocks(wsName);
      try {
        if (!workspaceRecord || !runtime) throw new LaunchCancelledError();
        const identity = workspaceRecord.getIdentity();
        if (!identity) throw new LaunchCancelledError();
        claim = await acquireWriterClaim(wsName, identity, this.ownClaimIds, { signal });

        const arb = await acquireLockHandle(lockNames.electionArb, { mode: "exclusive", signal });
        if (!arb) throw new LaunchCancelledError();
        try {
          published = await this.tryPublishDevAdmission(attemptId, revision, reservation, workspaceRecord, runtime, claim, signal, onCommit);
        } finally {
          arb.release();
        }
        if (!published) throw new LaunchCancelledError();
      } finally {
        if (this.activeLaunchReservation === reservation) this.activeLaunchReservation = null;
        if (claim && !published) {
          try { await claim.release(performance.now() + 1_000); } catch {}
        }
        if (this.pendingDevClaim === admissionPromise) this.pendingDevClaim = null;
      }
    })();

    this.pendingDevClaim = admissionPromise;
    return admissionPromise;
  }

  private async runDevServerLoop(revision: number, ws: WorkspaceRuntime): Promise<void> {
    if (!this.wasm || revision !== this.serverRevision || this.workspace !== ws) return;
    const { runtime, fs, browserPrograms } = ws;
    const term = this.termInstance!;
    const editor = this.editorInstance!;
    try {
      await fs.mkdirp("/tmp");
      if (revision !== this.serverRevision || this.workspace !== ws) return;
      await editor.flushAll();
      if (revision !== this.serverRevision || this.workspace !== ws) return;
      const visibleStart = this.firstStart ? 0 : performance.now();
      this.firstStart = false;
      this.setStatus("waiting for module service worker…");
      const programsInstalled = this.retryStorage(() => fs.flush())
        .then(() => {
          stage("flushed");
          return this.retryStorage(() => browserPrograms.ready());
        })
        .then((value) => { stage("programs-ready"); return value; });
      const [scoped, programs] = await Promise.all([
        ws.moduleScope.then((value) => { stage("module-scope-ready"); return value; }),
        programsInstalled,
        runtime.processes().then(() => stage("processes-ready")),
      ]);
      if (revision !== this.serverRevision || this.workspace !== ws) return;
      const env = this.buildDevEnv(programs.path, term);
      const options = { engine: this.engine, profile: this.profile, module: this.wasm.module, env, runtime, moduleScope: scoped, network: this.network };
      const result = await this.retryStorage(() => this.command("install", options, visibleStart, revision));
      if (!result || result.code !== 0 || result.error || revision !== this.serverRevision || this.workspace !== ws) return;
      await this.retryStorage(() => fs.flush());
      this.storageError = "";
      if (revision !== this.serverRevision || this.workspace !== ws) return;
      await this.command("dev", options, visibleStart, revision);
    } catch (error) {
      if (revision !== this.serverRevision || this.disposed || error instanceof ProvisionAbortedError) return;
      this.report(error);
    }
  }

  private withLocalLaunchPhase<T>(revision: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (revision !== this.serverRevision || this.localResetting || this.disposed) {
      return Promise.resolve(undefined);
    }
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => { resolveDone = res; });
    const entry = { controller, done };
    this.localStartupPhases.add(entry);
    return (async () => {
      try {
        if (revision !== this.serverRevision || this.localResetting || this.disposed || controller.signal.aborted) {
          return undefined;
        }
        return await fn(controller.signal);
      } catch (error) {
        if (controller.signal.aborted || revision !== this.serverRevision || this.localResetting || this.disposed) {
          return undefined;
        }
        throw error;
      } finally {
        this.localStartupPhases.delete(entry);
        resolveDone();
      }
    })();
  }

  private async startLocalDevServer(): Promise<void> {
    if (this.localResetting || this.disposed) return;
    this.stopDevServer();
    const revision = this.serverRevision;
    const ws = this.workspace;
    if (!this.wasm || !ws) return;
    const { runtime, fs, browserPrograms } = ws;
    const term = this.termInstance!;
    const editor = this.editorInstance!;

    if (this.stopping.size) {
      const ended = await Promise.all(Array.from(this.stopping, (run) => run.ended));
      if (revision !== this.serverRevision || this.localResetting || this.disposed) return;
      if (ended.includes(false)) term.write(`\x1b[33mThe previous dev server did not stop within ${STOP_WAIT_MS / 1000} s; starting anyway.\x1b[0m\r\n`);
    }

    const prepared = await this.withLocalLaunchPhase(revision, async (sig) => {
      await editor.flushAll(sig);
      if (revision !== this.serverRevision || this.localResetting || sig.aborted) return undefined;
      const visibleStart = this.firstStart ? 0 : performance.now();
      this.firstStart = false;
      this.setStatus("waiting for module service worker…");
      const programsInstalled = this.retryStorage(() => fs.flush())
        .then(() => {
          stage("flushed");
          return this.retryStorage(() => raceAbort(browserPrograms.ready(), sig));
        })
        .then((value) => { stage("programs-ready"); return value; });
      const [scoped, programs] = await Promise.all([
        raceAbort(ws.moduleScope, sig).then((value) => { stage("module-scope-ready"); return value; }),
        programsInstalled,
        raceAbort(runtime.processes(), sig).then(() => stage("processes-ready")),
      ]);
      if (revision !== this.serverRevision || this.localResetting || sig.aborted) return undefined;
      return { visibleStart, scoped, programs };
    });
    if (!prepared || !this.wasm || revision !== this.serverRevision || this.localResetting) return;

    const env = this.buildDevEnv(prepared.programs.path, term);
    const options = { engine: this.engine, profile: this.profile, module: this.wasm.module, env, runtime, moduleScope: prepared.scoped, network: this.network };
    const result = await this.retryStorage(async () => {
      if (revision !== this.serverRevision || this.localResetting || this.disposed) return undefined;
      return this.command("install", options, prepared.visibleStart, revision);
    });
    if (!result || result.code !== 0 || result.error || revision !== this.serverRevision || this.localResetting) return;

    const flushed = await this.withLocalLaunchPhase(revision, async (sig) => {
      await this.retryStorage(() => fs.flush());
      if (revision !== this.serverRevision || this.localResetting || sig.aborted) return false;
      this.storageError = "";
      return true;
    });
    if (!flushed || revision !== this.serverRevision || this.localResetting) return;
    await this.command("dev", options, prepared.visibleStart, revision);
  }

  private buildDevEnv(programsPath: string, term: Terminal): Record<string, string> {
    return {
      HOME,
      PWD: APP,
      USER: "user",
      PATH: programsPath,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(term.cols),
      LINES: String(term.rows),
      TMPDIR: "/tmp",
      PORT: String(PORT),
      BUN_WASM_STARTUP: "1",
      CI: "true",
    };
  }

  private async command(script: "install" | "dev", options: Omit<RunOptions, "args">, visibleStart: number, revision: number): Promise<RunResult | undefined> {
    const { startRun } = await import("../../web/src/runner");
    stage(`${script}-start`);
    if (revision !== this.serverRevision || this.disposed) return;
    const term = this.termInstance!;
    const args = script === "install" ? ["install"] : ["run", "dev"];
    const message = script === "install" ? "installing dependencies…" : "starting dev server…";
    this.setStatus(message);
    this.setServerState("starting", message);
    this.coordinator?.broadcastOwnerState("starting", message);
    term.write(`\x1b[2m$\x1b[0m bun ${args.join(" ")} \x1b[2m(${ENGINES[this.engine].name})\x1b[0m\r\n`);
    this.serverTiming = { started: performance.now(), visibleStart };
    let diagnostic = "";
    let storageFailed = false;
    const output = new StartupOutput(text => {
      diagnostic = (diagnostic + text).slice(-8192);
      storageFailed ||= isStorageFull(diagnostic);
      term.write(text);
    }, startupRecord);
    const hooks: RunHooks = { stdout: data => output.write(data), stderr: data => output.write(data) };
    const listenerRevision = this.listenerRevision;
    const current = startRun({ ...options, args }, hooks);
    this.run = current;
    const result = await current.done;
    stage(`${script}-done`);
    output.flush();
    if (result.error) term.write(`\x1b[31m${result.error}\x1b[0m\r\n`);
    if (this.run !== current) return;
    this.run = null;
    if (script === "install" && (storageFailed || isStorageFull(result.error))) {
      throw new Error("Dependency installation ran out of storage", { cause: `ENOSPC\n${result.error ?? ""}\n${diagnostic}` });
    }
    if (script === "install" && result.code === 0 && !result.error) return result;
    const missingServer = script === "dev" && this.listenerRevision === listenerRevision;
    if (missingServer) {
      const text = `Dev server stopped before it was ready (exit ${result.code}). Check the terminal output, then press Restart.`;
      this.setStatus(text, "error");
      if (result.code === 0 && !result.error) term.write(`\x1b[31m${text}\x1b[0m\r\n`);
    }
    if (!missingServer || result.code !== 0 || result.error) term.write(`\x1b[2m[${script} exited with code ${result.code}]\x1b[0m\r\n`);
    const downText = missingServer ? "dev server failed to start · press Restart" : `${script} stopped (exit ${result.code}) · press Restart`;
    this.setServerState("down", downText);
    this.coordinator?.broadcastOwnerState("down", downText);
    return result;
  }

  private retryStorage<T>(operation: () => Promise<T>): Promise<T> {
    return this.storage ? this.storage.recovery.retry(operation) : operation();
  }

  private loadEngine(): Promise<void> {
    if (this.wasm) return Promise.resolve();
    return this.engineLoading ??= this.downloadEngine().finally(() => { this.engineLoading = undefined; });
  }

  private async downloadEngine(): Promise<void> {
    try {
      this.wasm = await loadEngineProgram(this.engine, this.profile, (text) => this.setStatus(text), this.params.get("wasm") ?? undefined);
      stage("engine-ready");
    } catch (err) {
      const missing = err instanceof WasmMissing;
      this.setStatus(missing ? `${ENGINES[this.engine].wasm} is not in this build` : `could not load bun.wasm: ${String(err)}`, "error");
      this.setServerState("down", "no engine");
    }
  }

  private stopDevServer(): void {
    this.serverRevision++;
    const current = this.run;
    this.run = null;
    this.server = null;
    if (!current) return;
    current.kill(9);
    const stopping = stoppingRun(current.done, STOP_WAIT_MS);
    this.stopping.add(stopping);
    void stopping.ended.then(() => { this.stopping.delete(stopping); });
  }

  private isLivePreviewTarget(target: Server): boolean {
    return (
      this.server === target &&
      !this.disposed &&
      !this.workspace?.fs.ownershipLost &&
      target.token !== undefined &&
      this.previews.hasListener(target.port, target.token) &&
      (!this.coordinator || this.coordinator.role === "owner")
    );
  }

  private publishPreviewDown(target: Server, state: PreviewState): void {
    if (!this.isLivePreviewTarget(target)) return;
    const text = `previews need a service worker (${state} here)`;
    this.setServerState("down", text);
    this.coordinator?.broadcastOwnerState("down", text);
  }

  private publishPreviewUp(target: Server, visibleStart: number): void {
    if (!this.isLivePreviewTarget(target)) return;
    const url = this.previews.url(target.port, "/");
    this.setServerState("up", `localhost:${target.port}/`, url);
    this.coordinator?.broadcastOwnerState("up", `localhost:${target.port}/`, target.port);
    this.navigatePreviewFrame(target, url, visibleStart, true);
  }

  private async showPreview(target: Server, visibleStart: number): Promise<void> {
    if (!target.token) return;
    while (true) {
      const state = await this.previews.waitUntilRegistered(target.port, target.token);
      if (!this.isLivePreviewTarget(target)) return;
      if (state !== "ready") {
        this.publishPreviewDown(target, state);
        return;
      }
      if (!this.previews.isListenerReady(target.port, target.token)) continue;
      this.publishPreviewUp(target, visibleStart);
      return;
    }
  }

  private handleObservedOwnerState(state: OwnerBroadcastState): void {
    if (this.disposed || this.coordinator?.role === "owner") return;
    if (state.state === "up" && state.port !== undefined) {
      const tupleKey = `${state.ownerId}:${state.attemptId}:${state.generation}:${state.port}`;
      if (this.server?.remoteKey === tupleKey) return;
      const remoteServer: Server = { port: state.port, remoteKey: tupleKey };
      this.server = remoteServer;
      const url = this.previews.url(state.port, "/");
      this.setServerState("up", state.text, url);
      void this.previews.ready.then((swState) => {
        if (this.disposed || this.server !== remoteServer) return;
        if (swState !== "ready") {
          this.setServerState("down", `previews need a service worker (${swState} here)`);
          return;
        }
        this.navigatePreviewFrame(remoteServer, url, 0, false);
      });
      return;
    }
    this.preview = null;
    this.server = null;
    this.setServerState(state.state, state.text);
  }

  private navigatePreviewFrame(target: Server, url: string, visibleStart: number, isOwner: boolean): void {
    this.setStatus("loading preview…");
    const previewStarted = performance.now();
    const { frame } = this;
    if (!frame) return;
    let previous = frame.contentDocument;
    const requested = new URL(url);
    const navigation: PreviewNavigation = this.preview = { server: target, frame, url, loaded: null };
    let errorRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const isTransientPreviewError = (doc: Document): boolean => {
      if (!doc.contentType.startsWith("text/plain")) return false;
      const body = doc.body?.textContent ?? "";
      return body.startsWith("No bun.wasm server is listening on port ") || body.startsWith("bun.wasm server error:");
    };
    const isUnusablePreviewError = (doc: Document): boolean =>
      doc.contentType.startsWith("text/plain") && (doc.body?.textContent ?? "").startsWith("bun.wasm server sent an unusable response (");
    const loaded = (event: Event) => {
      if (this.preview !== navigation || this.server !== target || this.frame !== frame || this.workspace?.fs.ownershipLost) {
        clearTimeout(retryTimer);
        frame.removeEventListener("load", loaded);
        return;
      }
      let document: Document | null;
      try { document = frame.contentDocument; } catch { document = null; }
      if (!event.isTrusted || !document || document === previous || document.readyState !== "complete" || frame.src !== url) return;
      const final = new URL(document.URL);
      if (final.origin !== requested.origin || !final.pathname.startsWith(requested.pathname)) return;
      if (isUnusablePreviewError(document)) {
        clearTimeout(retryTimer);
        frame.removeEventListener("load", loaded);
        this.setStatus("preview failed · server sent an unusable response", "error");
        return;
      }
      if (isTransientPreviewError(document)) {
        if (errorRetries < 4) {
          previous = document;
          const delay = 250 * ++errorRetries;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            if (this.preview !== navigation || this.server !== target || this.frame !== frame || this.workspace?.fs.ownershipLost) return;
            frame.src = url;
          }, delay);
          return;
        }
        clearTimeout(retryTimer);
        frame.removeEventListener("load", loaded);
        this.setStatus("preview failed to load · press Restart", "error");
        return;
      }
      clearTimeout(retryTimer);
      frame.removeEventListener("load", loaded);
      navigation.loaded = { document, url: final.href };
      measureStartup("preview", previewStarted);
      this.setStatus(
        isOwner
          ? `dev server ready in ${((performance.now() - visibleStart) / 1000).toFixed(1)} s · ${ENGINES[this.engine].name} · ${mb(this.wasm?.size ?? 0)}`
          : `shared workspace live · preview served by active tab`,
        "ok",
      );
    };
    frame.addEventListener("load", loaded);
    frame.src = url;
  }

  private async save(
    path: string,
    text: string,
    revision: number,
    editResetGen = this.coordinator?.currentResetGeneration ?? 0,
    options: { resolveConflict?: boolean } = {},
  ): Promise<void> {
    try {
      await this.withAdmittedPageOp(
        async (ws, lease) => {
          const currentGen = lease?.resetGeneration ?? this.coordinator?.currentResetGeneration ?? 0;
          if (!options.resolveConflict && editResetGen !== currentGen) {
            throw new ResetGenerationMismatchError();
          }
          const write = () => this.retryStorage(async () => {
            await ws.fs.writeFile(abs(path), text);
            await ws.fs.flush(abs(path));
          });
          if (this.attachEnabled) {
            const identity = ws.getIdentity();
            if (!identity) throw new Error("Worker identity unavailable for save");
            await withWriterClaim(workspaceName(this.template), identity, this.ownClaimIds, write);
          } else {
            await write();
          }
        },
        { write: true },
      );
    } catch (error) {
      if (!(error instanceof ResetGenerationMismatchError)) this.report(error);
      throw error;
    }
    if (this.editorInstance?.settle(revision, { text: "saved", kind: "ok" })) {
      const wasStorageFailure = this.storageError !== "" || this.failure === "storage";
      this.storageError = "";
      if (this.failure === "storage") this.failure = undefined;
      if (wasStorageFailure) this.changed();
    }
  }

  teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = this.runTeardown();
    return this.teardownPromise;
  }

  private async runTeardown(): Promise<void> {
    const teardownDeadline = performance.now() + STOP_WAIT_MS;
    this.disposed = true;
    this.teardownRequested = true;
    this.serverRevision++;
    if (this.refreshFilesThrottleTimer !== null) {
      clearTimeout(this.refreshFilesThrottleTimer);
      this.refreshFilesThrottleTimer = null;
    }
    this.disposePreviewRecovery?.();
    this.disposePreviewRecovery = undefined;
    this.coordinator?.abortAllAsyncActivities();
    for (const phase of this.localStartupPhases) phase.controller.abort();
    this.watch?.stop();
    this.watch = null;
    this.provisionalBoot?.controller.abort();

    const initialFs = this.workspace?.fs ?? null;
    const initialWorkerIdentity = this.workspace?.getPartialWorkerIdentity() ?? null;
    const failedBeforeStartup = !this.started && initialFs?.state.status === "failed";

    if (this.previews instanceof HostedPreviews) {
      this.previews.revoke();
    } else {
      void this.previews.dispose();
    }
    if (this.coordinator?.role === "owner") {
      this.coordinator.broadcastOwnerStopping("close");
    }

    const retireResult = await this.retireRuntime({
      mode: "teardown",
      timeoutMs: Math.max(1, teardownDeadline - performance.now()),
    });
    const bootPromise = this.provisionalBoot?.promise ?? null;
    const bootJoinRes = await withDeadline(bootPromise ?? Promise.resolve(), teardownDeadline);
    await this.finalizeTeardown(
      retireResult,
      { timedOut: bootJoinRes.timedOut, promise: bootPromise },
      initialFs,
      initialWorkerIdentity,
      failedBeforeStartup,
    );
  }

  private async continueTeardown(
    initialFs: Filesystem | null,
    initialWorkerIdentity: PartialWorkerIdentity | null,
    failedBeforeStartup: boolean,
  ): Promise<void> {
    const deadline = performance.now() + STOP_WAIT_MS;
    const retireResult = await this.retireRuntime({ mode: "teardown", timeoutMs: STOP_WAIT_MS });
    const bootPromise = this.provisionalBoot?.promise ?? null;
    const bootJoinRes = await withDeadline(bootPromise ?? Promise.resolve(), deadline);
    await this.finalizeTeardown(
      retireResult,
      { timedOut: bootJoinRes.timedOut, promise: bootPromise },
      initialFs,
      initialWorkerIdentity,
      failedBeforeStartup,
    );
  }

  private async finalizeTeardown(
    retireResult: RetireResult,
    bootJoin: { timedOut: boolean; promise: Promise<void> | null },
    initialFs: Filesystem | null,
    initialWorkerIdentity: PartialWorkerIdentity | null,
    failedBeforeStartup: boolean,
  ): Promise<void> {
    const pending: Promise<unknown>[] = [];
    if (!retireResult.ok && retireResult.reason === "pending-settlement") pending.push(retireResult.pending);
    if (bootJoin.timedOut && bootJoin.promise) pending.push(bootJoin.promise.catch(() => {}));
    if (this.unsettledDisposals.size > 0) pending.push(Promise.allSettled(Array.from(this.unsettledDisposals)));

    if (pending.length > 0) {
      this.teardownContinuation ??= Promise.allSettled(pending).then(() => {
        this.teardownContinuation = null;
        return this.continueTeardown(initialFs, initialWorkerIdentity, failedBeforeStartup);
      });
      return;
    }

    if (!this.attachEnabled) {
      if (
        retireResult.ok &&
        !bootJoin.timedOut &&
        this.unsettledDisposals.size === 0 &&
        this.terminalDisposalFailures.length === 0 &&
        this.provisionalReopen === null
      ) {
        this.storage?.close();
        this.storage = undefined;
      }
      return;
    }

    const anyPendingOrFailedProvision = Array.from(this.provisioningState.values()).some(
      (s) => s === "rollback-failed" || s === "pending",
    );

    const releaseAll = async () => {
      const claim = this.devClaimHandle;
      this.devClaimHandle = null;
      await claim?.release(performance.now() + 1_000).catch(() => {});
      this.coordinator?.releaseOwnerLeasesInOrder();
      this.coordinator?.stop();
      this.releaseLiveWriters?.();
      this.releaseLiveWriters = null;
      this.presenceLock?.release();
      this.presenceLock = null;
      this.pageAliveLock?.release();
      this.pageAliveLock = null;
      this.storage?.close();
      this.storage = undefined;
    };

    // Case A: clean positive retirement.
    if (
      retireResult.ok &&
      !bootJoin.timedOut &&
      this.unsettledDisposals.size === 0 &&
      this.terminalDisposalFailures.length === 0 &&
      this.provisionalReopen === null &&
      !anyPendingOrFailedProvision
    ) {
      await releaseAll();
      return;
    }

    // Case B: failed before startup with verified zero worker locks held.
    if (
      !retireResult.ok &&
      !bootJoin.timedOut &&
      failedBeforeStartup &&
      this.terminalDisposalFailures.length === 0 &&
      !anyPendingOrFailedProvision &&
      initialFs?.state.status === "disposed" &&
      (await verifyWorkerLocksReleased(initialWorkerIdentity))
    ) {
      await releaseAll();
      return;
    }
    // Case C: retain all locks until page destruction.
  }
}

interface StoppingRun {
  readonly ended: Promise<boolean>;
}

function stoppingRun(done: Promise<unknown>, ms: number): StoppingRun {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(resolve, ms, false); });
  const settled = done.then(() => true, () => true);
  void settled.then(() => clearTimeout(timer));
  return { ended: Promise.race([settled, expired]) };
}

const stage = (name: string) => { performance.mark(`bunwasm:stage:${name}`); };
const rel = (path: string) => path.slice(APP.length + 1);
const abs = (relPath: string) => `${APP}/${relPath}`;

function createTerminal(): Terminal {
  return new Terminal({
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
    fontSize: window.matchMedia("(max-width: 800px)").matches ? 11 : 13,
    scrollback: 5000,
    theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#14151a", selectionBackground: "#3a3d4a" },
  });
}

function startupRecord(line: string): boolean {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return false; }
  if (!event || typeof event !== "object" || !("phase" in event) || !("duration" in event)) return false;
  if (typeof event.phase !== "string" || typeof event.duration !== "number") return false;
  measureStartup(event.phase, performance.now() - event.duration);
  return true;
}
