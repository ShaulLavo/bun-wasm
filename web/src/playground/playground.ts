import { TypedEventTarget } from "@remix-run/component";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createRuntime, type Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { memoryGroupPolicy } from "../host-memory-policy";
import { playgroundProfile, registerPlaygroundBun, templateProfile, type PlaygroundProfile } from "./program-profile";
import { ENGINE_BIN } from "../../../src/executable-paths";
import { BrowserPrograms, ProvisionAbortedError, type ProvisioningStatus } from "../browser-programs";
import { ENGINES, type Engine, WasmMissing, createToolsLoader, engineBuildHint, engineUnavailable, isEngine, loadEngineProgram, loadWasm, mb, registerModuleScope } from "../engine-loader";
import { installCompileObserver, measurementEnvironment } from "../compile-observer";
import { HOME, examples } from "../examples";
import { normalize } from "../fs";
import { HostedPreviews } from "../hosted-previews";
import type { BunNetworkOptions, RuntimeNetworkHelper } from "../net/helper";
import { Previews } from "../preview";
import { installRuntimeSharedObjects } from "../shared-objects/runtime";
import { getVfsDescriptor, UNSAVED_CHANGES_LOST, WORKSPACE_TAKEN_OVER } from "../shared-fs";
import type { BrowserSession, SessionState } from "bash-web/session";
import { START_FRESH_BUSY, startFresh, unreadableWorkspace } from "../start-fresh";
import { errorText } from "../startup";
import { commandChunks } from "../startup-cache";
import { entryAssetName, entryAssetUrl } from "../entry-assets";
import { openTerminal } from "../terminal-mount";
import { installPreviewLinks } from "./preview-links";
import { Editor } from "./editor";
import { projectTemplate, type ProjectTemplate } from "./project-templates";
import {
  acquireLockHandle,
  acquireWriterClaim,
  createWorkerIdentityObserver,
  fenceDeadWriters,
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
  type PeerWorkerIdentity,
  type WorkerIdentityObserver,
  type WriterClaimHandle,
} from "../workspace-claims";
import {
  upgradeReactRouterPreviewMount,
  withExclusiveLiveWriters,
  withProvisionBinsLock,
  withProvisionSeedLock,
} from "../workspace-provision";
import { startWorkspaceWatch, type WorkspaceWatchHandle } from "../workspace-watch";

type Filesystem = Runtime["filesystem"];
export type Status = { text: string; kind: "" | "ok" | "error" };
/** Why Run became Reload. Startup and ownership failures also lock the workspace controls. */
export type Failure = "startup" | "ownership" | "shell";

const DEFAULT_ENGINE: Engine = "browser";
const HOST_VERSIONS = {};
const STOP_WAIT_MS = 30_000;

/** The playground page: one Waffle runtime, the ~ workspace, bun.wasm, and an interactive bash-web shell. */
export class Playground extends TypedEventTarget<{ change: Event }> {
  readonly tabId = crypto.randomUUID();
  readonly engine: Engine;
  readonly profile: PlaygroundProfile;
  private readonly requestedProfile: PlaygroundProfile | undefined;
  readonly template: ProjectTemplate | undefined;
  term?: Terminal;
  editor?: Editor;
  failure?: Failure;
  /** Startup could not open the stored workspace, so Start fresh is offered. */
  unreadable = false;
  startingFresh = false;
  /** Startup finished with the workspace still owned by this tab. */
  ready = false;
  private readonly params: URLSearchParams;
  private readonly fit = new FitAddon();
  private terminalOpened!: () => void;
  private readonly terminalOpen = new Promise<void>((resolve) => { this.terminalOpened = resolve; });
  private runtime?: Runtime;
  private fs?: Filesystem;
  private sharedObjects?: ReturnType<typeof installRuntimeSharedObjects>;
  private browserPrograms?: BrowserPrograms;
  private previews?: Previews;
  private bunRegistration?: { dispose(): void };
  private watch?: WorkspaceWatchHandle;
  private identityObserver?: WorkerIdentityObserver;
  private shell?: BrowserSession;
  private shellState: SessionState = "starting";
  private runPending = false;
  private message: Status = { text: "", kind: "" };
  private disposePreviewLinks?: () => void;
  private disposePreviewRecovery?: () => void;
  private startupFailed = false;
  private disposed = false;
  private teardownRequested = false;
  private attachEnabled = false;
  private runtimeRetiredCleanly = false;
  private presenceLock: LockHandle | null = null;
  private pageAliveLock: LockHandle | null = null;
  private liveWritersLock: LockHandle | null = null;
  private shellClaimHandle: WriterClaimHandle | null = null;
  private readonly ownClaimIds = new Set<string>();
  private readonly admittedPageWrites = new Set<Promise<void>>();
  private readonly uncommittedProvisions = new Set<{ controller: AbortController; settled: Promise<void> }>();
  private readonly provisioningState = new Map<"base" | "bun", ProvisioningStatus>();
  private readonly unsettledDisposals = new Set<Promise<void>>();
  private readonly terminalDisposalFailures: unknown[] = [];
  private readonly intentionallyDisposedRuntimes = new WeakSet<Runtime>();
  private teardownPromise: Promise<void> | null = null;
  private teardownContinuation: Promise<void> | null = null;
  private bootAbortController: AbortController | null = null;
  private readonly pagehideHandler = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    void this.teardown();
  };
  /** Cleanups for work startup has done so far; they run the moment startup is abandoned. */
  private readonly abandonHooks = new Set<() => void>();

  /** Startup failed or another tab took the workspace: no late branch may publish or register. */
  private get abandoned(): boolean {
    return this.startupFailed || this.disposed || this.teardownRequested || this.fs?.ownershipLost === true;
  }

  private onAbandon(cleanup: () => void): void {
    if (this.abandoned) cleanup();
    else this.abandonHooks.add(cleanup);
  }

  private runAbandonHooks(): void {
    for (const cleanup of Array.from(this.abandonHooks)) cleanup();
    this.abandonHooks.clear();
  }

  private abandonStartup(): void {
    this.startupFailed = true;
    this.runAbandonHooks();
  }

  constructor(search: string) {
    super();
    this.params = new URLSearchParams(search);
    this.template = projectTemplate(this.params.get("template"));
    const requested = this.params.get("engine");
    if (requested !== null && !isEngine(requested)) throw new TypeError(`Unknown Bun engine: ${requested}`);
    this.engine = requested ?? DEFAULT_ENGINE;
    const profile = this.params.get("profile");
    this.requestedProfile = profile === null ? undefined : playgroundProfile(profile);
    this.profile = this.profileForEngine(this.engine);
  }

  profileForEngine(engine: Engine): PlaygroundProfile {
    return templateProfile(engine, this.template?.id, this.requestedProfile);
  }

  get status(): Status {
    if (this.fs?.ownershipLost) return { text: `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`, kind: "error" };
    return this.message;
  }

  /** New file, engine and file choices need a started workspace this tab still owns. */
  get locked(): boolean {
    return !this.ready || (this.failure !== undefined && this.failure !== "shell");
  }

  get canRun(): boolean {
    return this.ready && this.shellState === "ready" && !this.runPending && !this.shell?.running;
  }

  async start(): Promise<void> {
    try {
      await this.boot();
    } catch (error) {
      this.abandonStartup();
      console.error(error);
      this.unreadable = this.fast && !this.fs?.ownershipLost && unreadableWorkspace(error, this.fs?.state);
      this.message = this.unreadable
        ? { text: `This browser's saved copy of the workspace cannot be opened. Start fresh deletes it and opens a new one. ${errorText(error)}`, kind: "error" }
        : { text: errorText(error), kind: "error" };
      this.failure = "startup";
      if (!this.unreadable) {
        void this.teardown();
      }
      this.changed();
    }
  }

  /** Deletes a workspace that cannot be opened, then reloads into a fresh one. */
  async startFresh(): Promise<void> {
    if (!this.unreadable || this.startingFresh) return;
    this.startingFresh = true;
    this.changed();
    try {
      const result = await startFresh(() => this.teardown(), this.workspaceName);
      if (result !== "busy") { location.reload(); return; }
      this.setStatus(START_FRESH_BUSY, "error");
    } catch (error) {
      this.setStatus(`Start fresh failed. ${errorText(error)}`, "error");
    }
    this.startingFresh = false;
    this.changed();
  }

  private get fast(): boolean {
    try { return getVfsDescriptor(this.params.get("mode") ?? "fast").mode === "fast"; } catch { return false; }
  }

  private get workspaceName(): string {
    return this.template ? `bun-wasm-workspace-${this.template.id}` : "bun-wasm-workspace";
  }

  private getIdentity(): PeerWorkerIdentity | null {
    return this.identityObserver?.getIdentity() ?? null;
  }

  private trackUnsettled(promise: Promise<void>): Promise<void> {
    return trackUnsettledPromise(promise, this.unsettledDisposals, this.terminalDisposalFailures);
  }

  private admitProvision<T>(runtime: Runtime, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.runtime !== runtime || runtime.disposed || this.disposed || this.teardownRequested) {
      return Promise.reject(new ProvisionAbortedError());
    }
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((res) => { resolveSettled = res; });
    const entry = { controller, settled };
    this.uncommittedProvisions.add(entry);
    return (async () => {
      try {
        if (this.attachEnabled) {
          const identity = this.getIdentity();
          if (!identity) throw new ProvisionAbortedError("Worker identity unavailable for provisioning");
          return await withProvisionBinsLock(
            this.workspaceName,
            runtime.filesystem,
            this.ownClaimIds,
            () => withWriterClaim(
              this.workspaceName,
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

  private withPlaygroundPageWrite<T>(fn: (fs: Filesystem) => Promise<T>): Promise<T> {
    const fs = this.fs;
    if (!fs || this.disposed || this.teardownRequested || this.runtime?.disposed) {
      return Promise.reject(new Error("Playground workspace is unavailable"));
    }
    let resolveTrack!: () => void;
    const tracked = new Promise<void>((res) => { resolveTrack = res; });
    this.admittedPageWrites.add(tracked);
    return (async () => {
      try {
        if (this.attachEnabled) {
          const identity = this.getIdentity();
          if (!identity) throw new Error("Playground worker identity is not ready");
          await fenceDeadWriters(this.workspaceName, fs, this.ownClaimIds);
          return await withWriterClaim(this.workspaceName, identity, this.ownClaimIds, () => fn(fs));
        }
        return await fn(fs);
      } finally {
        this.admittedPageWrites.delete(tracked);
        resolveTrack();
      }
    })();
  }

  openTerminal(term: Terminal, node: HTMLElement, signal: AbortSignal): void {
    openTerminal(term, this.fit, node, signal);
    signal.addEventListener("abort", () => this.disposePreviewLinks?.(), { once: true });
    this.terminalOpened();
  }

  chooseEngine(engine: string): void {
    const next = new URL(location.href);
    if (engine === DEFAULT_ENGINE) next.searchParams.delete("engine");
    else next.searchParams.set("engine", engine);
    next.searchParams.delete("wasm");
    location.assign(next);
  }

  async run(): Promise<void> {
    const { editor, shell } = this;
    if (!this.ready || !editor || !shell || shell.running || this.runPending) return;
    this.runPending = true;
    this.changed();
    try {
      const path = editor.path;
      await editor.save();
      const quoted = `'${path.replace(/'/g, "'\\''")}'`;
      const command = /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ? "test" : "run";
      await shell.submit(`bun ${command} ${quoted}`);
    } finally {
      this.runPending = false;
      this.changed();
    }
  }

  async newFile(name: string): Promise<void> {
    const { editor } = this;
    if (!editor || !this.fs) return;
    const path = normalize(name, HOME);
    await this.withPlaygroundPageWrite(async (fs) => {
      const client = new FilesystemClient(fs.fork());
      try {
        await client.asyncCall("writeFile", [path, false, true], new Uint8Array());
        await fs.flush(path);
      } catch (error) {
        if (!error || typeof error !== "object" || !("errno" in error) || error.errno !== 20) {
          throw error;
        }
      } finally {
        client.dispose();
      }
    });
    await editor.open(path);
    editor.focus();
  }

  readonly report = (error: unknown): void => {
    this.setStatus(String(error), "error");
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

  teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = this.runTeardown();
    return this.teardownPromise;
  }

  private async runTeardown(): Promise<void> {
    const deadline = performance.now() + STOP_WAIT_MS;
    this.disposed = true;
    this.teardownRequested = true;
    this.disposePreviewRecovery?.();
    this.disposePreviewRecovery = undefined;
    this.bootAbortController?.abort();
    this.watch?.stop();
    this.watch = undefined;
    for (const prov of this.uncommittedProvisions) prov.controller.abort();

    const initialFs = this.fs ?? null;
    const initialWorkerIdentity = this.identityObserver?.getPartialWorkerIdentity() ?? null;
    const failedBeforeStartup = !this.ready && initialFs?.state.status === "failed";

    if (this.previews instanceof HostedPreviews) {
      this.previews.revoke();
    } else {
      void this.previews?.dispose();
    }

    const retireOk = await this.retireRuntimeForTeardown(deadline);
    await this.finalizeTeardown(retireOk, initialFs, initialWorkerIdentity, failedBeforeStartup);
  }

  private async retireRuntimeForTeardown(deadline: number): Promise<"ok" | "pending-settlement" | "failed"> {
    if (!this.attachEnabled && this.admittedPageWrites.size === 0 && this.uncommittedProvisions.size === 0 && this.sharedObjects) {
      const syncShared = this.sharedObjects;
      this.sharedObjects = undefined;
      try { syncShared.close(); } catch (err) { this.terminalDisposalFailures.push(err); }
    }
    const pendingWrites = Promise.allSettled(Array.from(this.admittedPageWrites));
    const writesRes = await withDeadline(pendingWrites, deadline);
    if (writesRes.timedOut) return "pending-settlement";

    const pendingProvs = Promise.allSettled(Array.from(this.uncommittedProvisions, (p) => p.settled));
    const provsRes = await withDeadline(pendingProvs, deadline);
    if (provsRes.timedOut) return "pending-settlement";

    const runtime = this.runtime;
    const sharedObjects = this.sharedObjects;
    const browserPrograms = this.browserPrograms;
    const shell = this.shell;
    const bunReg = this.bunRegistration;

    this.runtime = undefined;
    this.sharedObjects = undefined;
    this.browserPrograms = undefined;
    this.shell = undefined;
    this.bunRegistration = undefined;
    this.identityObserver?.dispose();

    const runCleanup = (fn: () => Promise<unknown> | void): Promise<void> => {
      try { return Promise.resolve(fn()).then(() => {}); } catch (err) { return Promise.reject(err); }
    };

    if (runtime || sharedObjects || browserPrograms || shell || bunReg) {
      if (runtime) this.intentionallyDisposedRuntimes.add(runtime);
      this.runtimeRetiredCleanly = false;
      const bundle = this.trackUnsettled(
        Promise.allSettled([
          runCleanup(() => shell?.dispose()),
          runCleanup(() => bunReg?.dispose()),
          runCleanup(() => sharedObjects?.close()),
          runCleanup(() => runtime?.dispose()),
          runCleanup(() => browserPrograms?.dispose()),
        ]).then((results) => {
          const errs = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => r.reason);
          if (errs.length > 0) {
            throw errs.length === 1 ? errs[0] : new AggregateError(errs, "Playground runtime disposal failed");
          }
          if (this.terminalDisposalFailures.length === 0) {
            this.runtimeRetiredCleanly = true;
          }
        }),
      );
      const dispRes = await withDeadline(bundle, deadline);
      if (dispRes.timedOut) return "pending-settlement";
      if (dispRes.rejected) return "failed";
    } else if (this.unsettledDisposals.size === 0 && this.terminalDisposalFailures.length === 0) {
      this.runtimeRetiredCleanly = true;
    }

    if (
      this.previews instanceof HostedPreviews &&
      !this.previews.hasActiveConsumer() &&
      this.unsettledDisposals.size === 0 &&
      this.terminalDisposalFailures.length === 0
    ) {
      const prevRes = await withDeadline(this.trackUnsettled(this.previews.dispose()), deadline);
      if (prevRes.timedOut) return "pending-settlement";
      if (prevRes.rejected) return "failed";
    }

    if (this.unsettledDisposals.size > 0) {
      const remRes = await withDeadline(Promise.allSettled(Array.from(this.unsettledDisposals)), deadline);
      if (remRes.timedOut) return "pending-settlement";
    }

    const anyRollbackFailed = Array.from(this.provisioningState.values()).some((s) => s === "rollback-failed" || s === "pending");
    return this.runtimeRetiredCleanly && this.terminalDisposalFailures.length === 0 && !anyRollbackFailed ? "ok" : "failed";
  }

  private async finalizeTeardown(
    retireOutcome: "ok" | "pending-settlement" | "failed",
    initialFs: Filesystem | null,
    initialWorkerIdentity: { workerClientId: string | null; peerAliveLock: string | null } | null,
    failedBeforeStartup: boolean,
  ): Promise<void> {
    if (retireOutcome === "pending-settlement" || this.unsettledDisposals.size > 0) {
      const pending: Promise<unknown>[] = [
        ...Array.from(this.admittedPageWrites),
        ...Array.from(this.uncommittedProvisions, (p) => p.settled),
        ...Array.from(this.unsettledDisposals),
      ];
      this.teardownContinuation ??= Promise.allSettled(pending).then(async () => {
        this.teardownContinuation = null;
        const nextOutcome = await this.retireRuntimeForTeardown(performance.now() + STOP_WAIT_MS);
        await this.finalizeTeardown(nextOutcome, initialFs, initialWorkerIdentity, failedBeforeStartup);
      });
      return;
    }

    if (!this.attachEnabled) return;

    const anyRollbackFailed = Array.from(this.provisioningState.values()).some((s) => s === "rollback-failed" || s === "pending");
    const releaseAllLocks = async () => {
      const claim = this.shellClaimHandle;
      this.shellClaimHandle = null;
      await claim?.release(performance.now() + 1_000).catch(() => {});
      this.liveWritersLock?.release();
      this.liveWritersLock = null;
      this.presenceLock?.release();
      this.presenceLock = null;
      this.pageAliveLock?.release();
      this.pageAliveLock = null;
    };

    // Case A: clean positive retirement.
    if (retireOutcome === "ok" && this.terminalDisposalFailures.length === 0 && !anyRollbackFailed) {
      await releaseAllLocks();
      return;
    }

    // Case B: failed before startup with verified zero worker locks held.
    if (
      failedBeforeStartup &&
      this.terminalDisposalFailures.length === 0 &&
      !anyRollbackFailed &&
      initialFs?.state.status === "disposed" &&
      (await verifyWorkerLocksReleased(initialWorkerIdentity))
    ) {
      await releaseAllLocks();
      return;
    }
    // Case C: retain all locks until page destruction.
  }

  private async boot(): Promise<void> {
    installCompileObserver();
    const engineEnv = {
      ...(this.engine === "spidermonkey" ? { BUN_WASM_SPIDERMONKEY_TIER: "interp" } : {}),
      ...measurementEnvironment(this.params),
    };
    const mode = getVfsDescriptor(this.params.get("mode") ?? "fast").mode;
    const hasWebLocks = typeof navigator !== "undefined" && Boolean(navigator.locks);
    const hasBroadcastChannel = typeof BroadcastChannel === "function";
    this.attachEnabled = mode === "fast" && hasWebLocks && hasBroadcastChannel;

    const bootController = new AbortController();
    this.bootAbortController = bootController;
    const bootSignal = bootController.signal;

    if (typeof addEventListener === "function") {
      addEventListener("pagehide", this.pagehideHandler);
    }

    if (this.attachEnabled) {
      this.presenceLock = await acquireLockHandle(presenceLockName(this.workspaceName), { mode: "shared", signal: bootSignal });
      this.pageAliveLock = await acquireLockHandle(pageAliveLockName(this.workspaceName, this.tabId), { mode: "exclusive", signal: bootSignal });
    }

    const fsWorker = entryAssetName("fs-worker.js");
    const workerInstanceId = crypto.randomUUID();
    const pageAlive = pageAliveLockName(this.workspaceName, this.tabId);
    let observer: WorkerIdentityObserver | undefined;
    let runtime: Runtime | undefined;
    let sharedObjects: ReturnType<typeof installRuntimeSharedObjects> | undefined;
    let browserPrograms: BrowserPrograms | undefined;

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
        ? { mode: "memory" as const, name: this.workspaceName, ...(workerURL ? { workerURL } : {}) }
        : {
          mode,
          name: this.workspaceName,
          ...(workerURL ? { workerURL } : {}),
          ...(this.attachEnabled ? { whenBusy: "attach" as const } : {}),
        };
      runtime = createRuntime({
        filesystem,
        memoryGroups: memoryGroupPolicy(this.engine, navigator.userAgent),
      });
      sharedObjects = installRuntimeSharedObjects(runtime);
      const createdRuntime = runtime;
      browserPrograms = new BrowserPrograms(
        createdRuntime,
        {
          worker: entryAssetUrl("./preview1-worker.js"),
          shell: new URL("./programs/shell-engine.wasm", globalThis.location?.href ?? import.meta.url),
          shellWorker: entryAssetUrl("./shell-worker.js"),
        },
        {
          runTransaction: (fn) => this.admitProvision(createdRuntime, fn),
          onStateChange: (state) => { this.provisioningState.set("base", state); },
        },
      );
    } catch (error) {
      try { observer?.dispose(); } catch {}
      if (!runtime && !sharedObjects && !browserPrograms) {
        if (this.unsettledDisposals.size === 0 && this.terminalDisposalFailures.length === 0) {
          this.runtimeRetiredCleanly = true;
        }
      } else {
        if (runtime) this.intentionallyDisposedRuntimes.add(runtime);
        this.runtimeRetiredCleanly = false;
        const r = runtime;
        const s = sharedObjects;
        const b = browserPrograms;
        const runCleanup = (fn: () => Promise<unknown> | void): Promise<void> => {
          try { return Promise.resolve(fn()).then(() => {}); } catch (e) { return Promise.reject(e); }
        };
        const partialCleanup = Promise.allSettled([
          runCleanup(() => s?.close()),
          runCleanup(() => r?.dispose()),
          runCleanup(() => b?.dispose()),
        ]).then((results) => {
          const errs = results
            .filter((res): res is PromiseRejectedResult => res.status === "rejected")
            .map((res) => res.reason);
          if (errs.length > 0) {
            throw errs.length === 1 ? errs[0] : new AggregateError(errs, "Partial playground runtime cleanup failed");
          }
          if (!this.runtime && this.terminalDisposalFailures.length === 0) {
            this.runtimeRetiredCleanly = true;
          }
        });
        this.trackUnsettled(partialCleanup);
      }
      throw error;
    }

    this.identityObserver = observer;
    this.runtime = runtime;
    this.sharedObjects = sharedObjects;
    this.browserPrograms = browserPrograms;
    const fs = this.fs = runtime.filesystem;

    fs.onStateChange = (state) => {
      if (state.status === "waiting") {
        this.setStatus("Waiting for this workspace to close in another tab. It will open here automatically.");
      } else if (state.status === "disposed" && !this.intentionallyDisposedRuntimes.has(runtime!)) {
        void this.teardown();
      }
    };

    const input = new InputGate();
    let startedShell: BrowserSession | undefined;
    let retiring: Promise<void> | undefined;
    const retireShell = () => {
      if (startedShell) retiring ??= startedShell.dispose().catch(() => {});
      return retiring;
    };
    fs.onOwnershipLost = () => {
      this.failure = "ownership";
      input.close();
      if (!this.ready) {
        void retireShell();
        this.runAbandonHooks();
      }
      void this.teardown();
      this.changed();
    };

    const wasmReady = this.loadEngine().then(value => { stage("engine-ready"); return value; });
    const sessionModule = import("bash-web/session");
    const promptModule = this.params.get("prompt") === "off" ? Promise.resolve(undefined) : import("bash-web/prompt");
    for (const pending of [sessionModule, promptModule]) pending.catch(() => {});

    if (this.attachEnabled && observer) {
      await Promise.all([
        raceAbort(observer.identityReady, bootSignal),
        probeFilesystemReady(fs, bootSignal),
      ]);
      const identity = observer.getIdentity()!;
      await withProvisionSeedLock(
        this.workspaceName,
        fs,
        this.ownClaimIds,
        async () => {
          await withWriterClaim(this.workspaceName, identity, this.ownClaimIds, () => fs.mkdirp("/tmp"), { signal: bootSignal });
          stage("filesystem-open");
          await withExclusiveLiveWriters(
            this.workspaceName,
            fs,
            this.ownClaimIds,
            async () => {
              await withWriterClaim(
                this.workspaceName,
                identity,
                this.ownClaimIds,
                async () => {
                  if (this.template) {
                    const { loadTemplate } = await import("../../../sandbox/src/template");
                    await loadTemplate(fs, HOME, this.template.file, false, { signal: bootSignal });
                  } else {
                    await seedExamples(fs);
                  }
                  await upgradeReactRouterPreviewMount(fs, HOME);
                },
                { signal: bootSignal },
              );
            },
            { signal: bootSignal },
          );
        },
        { signal: bootSignal },
      );
      this.liveWritersLock = await acquireLockHandle(liveWritersLockName(this.workspaceName), {
        mode: "shared",
        signal: bootSignal,
      });
    } else {
      await fs.mkdirp("/tmp");
      stage("filesystem-open");
      if (this.template) {
        const { loadTemplate } = await import("../../../sandbox/src/template");
        await loadTemplate(fs, HOME, this.template.file, false, { signal: bootSignal });
      } else {
        await seedExamples(fs);
      }
      await upgradeReactRouterPreviewMount(fs, HOME);
    }

    const moduleScope = registerModuleScope().then(value => { stage("module-scope-ready"); return value; });
    const programsReady = browserPrograms.ready().then(value => { stage("programs-ready"); return value; });
    programsReady.catch(() => {});
    stage("workspace-ready");

    const previewRoute = `pg-${this.tabId}`;
    const previews = this.previews = this.params.has("root-previews")
      ? new HostedPreviews(() => runtime!, location.href, { managePageHide: false })
      : new Previews({ baseURL: location.href, prefix: "__preview", route: previewRoute });

    const term = this.term = createTerminal();
    term.loadAddon(this.fit);
    const previewPorts = new Set<number>();
    const activePreviewTokens = new Map<number, { helper: RuntimeNetworkHelper; token: symbol; printed: boolean }>();
    this.disposePreviewLinks = installPreviewLinks(term, previews, previewPorts, () => this.editor?.focus());

    const announcePort = async (port: number, token: symbol) => {
      while (true) {
        const state = await previews.waitUntilRegistered(port, token);
        if (this.disposed || !previews.hasListener(port, token)) return;
        const rec = activePreviewTokens.get(port);
        if (!rec || rec.token !== token) return;
        if (state === "ready" && !previews.isListenerReady(port, token)) continue;
        rec.printed = state === "ready";
        term.write(previewLine(previews, port, state));
        return;
      }
    };

    this.disposePreviewRecovery = previews.onWorkerRecovered(() => {
      if (this.disposed) return;
      for (const [port, rec] of Array.from(activePreviewTokens)) {
        if (!rec.printed && previews.hasListener(port, rec.token)) {
          void announcePort(port, rec.token);
        }
      }
    });

    const network: BunNetworkOptions = {
      listening: (port, helper) => {
        const token = previews.registerListener(port, helper);
        previewPorts.add(port);
        activePreviewTokens.set(port, { helper, token, printed: false });
        void announcePort(port, token);
      },
      stopped: (port, helper) => {
        const rec = activePreviewTokens.get(port);
        if (rec?.helper === helper) {
          activePreviewTokens.delete(port);
          previews.unregisterListener(port, rec.token);
        } else {
          previews.unregister(port, helper);
        }
        if (!previews.serves(port)) previewPorts.delete(port);
      },
    };

    const editor = this.editor = new Editor(fs, {
      run: () => this.run(),
      report: this.report,
      changed: () => this.changed(),
      saveFile: (path, text) =>
        this.withPlaygroundPageWrite(async (liveFs) => {
          await liveFs.writeFile(path, text);
          await liveFs.flush(path);
        }),
    });
    this.changed();
    await this.terminalOpen;
    await editor.open(this.template ? `${HOME}/${this.template.editorFile}` : editor.path);

    if (this.attachEnabled) {
      this.watch = startWorkspaceWatch({
        fs,
        targetPath: HOME,
        onPaths: (paths) => editor.syncPaths(paths),
        onReconcile: () => editor.syncFromFs(),
      });
      await raceAbort(this.watch.ready, bootSignal);
    }

    this.printWelcomeBanner(term, fs);

    term.onData(data => input.write(data));
    const shellEnded = Promise.withResolvers<never>();
    shellEnded.promise.catch(() => {});
    const shellState = (state: SessionState, detail?: string) => {
      this.shellChanged(state, detail);
      if (this.ready || (state !== "failed" && state !== "exited")) return;
      shellEnded.reject(new Error(detail ?? `The shell ${state} during startup. Reload to start another session.`));
    };
    const shellReady = this.startShellSession({
      runtime,
      term,
      bootSignal,
      programsReady,
      sessionModule,
      promptModule,
      engineEnv,
      shellState,
      onStarted: (shell) => {
        startedShell = shell;
        if (this.abandoned) void retireShell();
        else this.shell = shell;
      },
    });

    const engine = this.engine;
    const registering = this.registerBun(runtime, network, moduleScope, wasmReady);
    let shell: Awaited<typeof shellReady>;
    let registration: Awaited<ReturnType<typeof registerPlaygroundBun>>;
    let size: number;
    try {
      [shell, { registration, size }] = await Promise.race([Promise.all([shellReady, registering]), shellEnded.promise]);
    } catch (error) {
      this.abandonStartup();
      void retireShell();
      void registering.then(registered => registered.registration.dispose()).catch(() => {});
      if (fs.ownershipLost) return;
      throw error;
    }
    if (fs.ownershipLost || this.disposed) {
      this.shell = undefined;
      registration.dispose();
      await retireShell();
      return;
    }
    this.bunRegistration = registration;
    input.open(data => {
      try { shell.input(data); } catch (error) { this.report(error); }
    });

    Object.assign(globalThis, { playground: { runtime, fs, shell, term, editor, previews, sharedObjects, engine, profile: registration.profile, dispose: () => this.teardown() } });
    this.abandonHooks.clear();
    this.ready = !fs.ownershipLost && !this.disposed;
    this.setStatus(`bun.wasm ready · ${ENGINES[engine].name} · ${mb(size)}`, "ok");
    if (this.ready) whenIdle(warmFirstCommand);
  }

  private printWelcomeBanner(term: Terminal, fs: Filesystem): void {
    const storage = fs.vfs.persistent ? "persistent browser storage" : "memory-only browser storage";
    const durability = fs.vfs.persistent ? "survive" : "do not survive";
    for (const line of [
      "\x1b[1mBun in your browser\x1b[0m: bun.wasm (wasm32-wasip1) in a Web Worker.",
      this.template
        ? `${this.template.label}: run bun install, then bun run dev. Open its preview link, edit ${this.template.editorFile}, and save with Ctrl/Cmd-S.`
        : "Try \x1b[32mbun repl\x1b[0m, \x1b[32mbun run index.ts\x1b[0m, or press Run.",
      `filesystem: ${storage}, preopened at /, cwd ${HOME}; editor saves ${durability} reload`,
      "",
    ]) term.writeln(line);
  }

  private async startShellSession(params: {
    runtime: Runtime;
    term: Terminal;
    bootSignal: AbortSignal;
    programsReady: Promise<{ path: string }>;
    sessionModule: Promise<typeof import("bash-web/session")>;
    promptModule: Promise<typeof import("bash-web/prompt") | undefined>;
    engineEnv: Record<string, string>;
    shellState: (state: SessionState, detail?: string) => void;
    onStarted: (shell: BrowserSession) => void;
  }): Promise<BrowserSession> {
    const [programs, { BrowserSession }, prompts] = await Promise.all([
      params.programsReady,
      params.sessionModule,
      params.promptModule,
    ]);
    if (this.attachEnabled) {
      const identity = this.getIdentity();
      if (!identity) throw new Error("Worker identity missing before shell start");
      this.shellClaimHandle = await acquireWriterClaim(this.workspaceName, identity, this.ownClaimIds, { signal: params.bootSignal });
    }
    const prompt = prompts?.createPrompt({
      filesystem: params.runtime.filesystem,
      versions: HOST_VERSIONS,
      file: true,
      logger: (message: string, error?: unknown) => console.warn(`[prompt] ${message}`, error ?? ""),
    });
    const shell = await BrowserSession.create({
      runtime: params.runtime,
      cwd: HOME,
      env: { ...params.engineEnv, HOME, USER: "user", PATH: `${ENGINE_BIN[this.engine]}:${programs.path}`, TERM: "xterm-256color", COLORTERM: "truecolor", TMPDIR: "/tmp", PS1: "$ " },
      cols: params.term.cols,
      rows: params.term.rows,
      wasmUrl: new URL("./programs/shell-engine.wasm", location.href),
      workerUrl: entryAssetUrl("./shell-worker.js"),
      lineEditor: { mode: "zsh" },
      prompt,
      onOutput: bytes => params.term.write(bytes),
      onState: params.shellState,
    });
    stage("shell-created");
    params.onStarted(shell);
    params.term.onResize(({ cols, rows }) => shell.resize(cols, rows));
    return shell;
  }

  /** Registers Bun once its engine and module scope are ready, with flush & rollback inside the admitted bins lock. */
  private async registerBun(runtime: Runtime, network: BunNetworkOptions, moduleScope: Promise<boolean>, wasmReady: ReturnType<Playground["loadEngine"]>) {
    const [scoped, wasm] = await Promise.all([moduleScope, wasmReady]);
    if (wasm instanceof Error) throw wasm;
    if (this.abandoned) throw new Error("Playground startup was abandoned before Bun registration");
    const loadTools = createToolsLoader();
    const registration = await registerPlaygroundBun({
      runtime,
      engine: this.engine,
      module: wasm.module,
      profile: this.profile,
      loadModule: (provider, profile) => loadEngineProgram(provider, profile, () => {}).then(loaded => loaded.module),
      launcher: provider => async (context, service) => {
        const { bunLauncher } = await import("../bun-launcher");
        return bunLauncher(provider, {
          runtime,
          network,
          workerUrl: entryAssetUrl(scoped ? "./__bunwasm/worker.js" : "./worker.js").href,
          notificationWorkerUrl: entryAssetUrl("./notification-worker.js").href,
          loadTools,
        })(context, service);
      },
      abandoned: () => this.abandoned,
      runTransaction: (fn) => this.admitProvision(runtime, fn),
      onStateChange: (state) => { this.provisioningState.set("bun", state); },
    });
    this.onAbandon(() => registration.dispose());
    stage("bun-registered");
    stage("flushed");
    return { registration, size: wasm.size };
  }

  private async loadEngine(): Promise<Awaited<ReturnType<typeof loadWasm>> | Error> {
    const unavailable = engineUnavailable(this.engine, this.profile);
    if (unavailable) return new Error(unavailable);
    try {
      return await loadEngineProgram(this.engine, this.profile, (text) => { if (!this.abandoned) this.setStatus(text); }, this.params.get("wasm") ?? undefined);
    } catch (err) {
      return new Error(err instanceof WasmMissing
        ? `${String(err)}. ${engineBuildHint(this.engine)}`
        : `could not load bun.wasm: ${String(err)}`);
    }
  }

  private shellChanged(state: SessionState, detail?: string): void {
    if (state !== this.shellState) stage(`shell-${state}`);
    this.shellState = state;
    if (state === "ready") void this.editor?.syncFromFs().catch(this.report);
    if (state === "failed" || state === "exited") {
      this.failure ??= "shell";
      this.report(detail ?? "Shell exited. Reload to start another session.");
    }
    this.changed();
  }
}

/**
 * Background persistence can save a prefix of startup. Publish completion only after every
 * example is present; a missing marker retries an interrupted seed from scratch. After
 * completion, missing examples are intentional deletions and stay deleted.
 */
async function seedExamples(fs: Filesystem): Promise<void> {
  const initialized = `${HOME}/.bunwasm-initialized`;
  if (await fs.lookup(initialized)) return;
  await fs.remove(HOME);
  await fs.mkdirp(HOME);
  for (const [name, source] of Object.entries(examples)) await fs.writeFile(`${HOME}/${name}`, source);
  await fs.mkdirp(initialized);
  await fs.flush();
}

/** Holds terminal input until its consumer opens, then delivers it in order. Closing is final. */
export class InputGate {
  private readonly queued: string[] = [];
  private consumer: ((data: string) => void) | undefined;
  private closed = false;

  write(data: string): void {
    if (this.closed) return;
    if (this.consumer) this.consumer(data);
    else this.queued.push(data);
  }

  open(consumer: (data: string) => void): void {
    if (this.closed) return;
    this.consumer = consumer;
    for (const data of this.queued.splice(0)) consumer(data);
  }

  /** Drops queued input and everything typed later. */
  close(): void {
    this.closed = true;
    this.consumer = undefined;
    this.queued.length = 0;
  }
}

/** Boot waterfall marks on the navigation clock, read by sandbox/tests/page-load-profile.ts. */
function stage(name: string): void {
  performance.mark(`bunwasm:stage:${name}`);
}

function createTerminal(): Terminal {
  return new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
    fontSize: window.matchMedia("(max-width: 800px)").matches ? 13 : 14,
    scrollback: 5000,
    theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#fbf0df", selectionBackground: "#3a3d4a" },
  });
}

function previewLine(previews: Previews, port: number, state: string): string {
  if (state !== "ready") return `\x1b[2m[preview] port ${port}: preview transport is ${state}\x1b[0m\r\n`;
  const url = previews.url(port);
  return `\x1b[2m[preview]\x1b[0m \x1b]8;;${url}\x07\x1b[4;36m${url}\x1b[0m\x1b]8;;\x07 \x1b[2m(Ctrl-C stops the server)\x1b[0m\r\n`;
}

function warmFirstCommand(): void {
  for (const chunk of commandChunks()) void fetch(chunk, { priority: "low" }).then(response => response.arrayBuffer()).catch(() => {});
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}
