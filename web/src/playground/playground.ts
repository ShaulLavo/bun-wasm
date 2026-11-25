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
import type { BunNetworkOptions, BunProcessStart, RuntimeNetworkHelper } from "../net/helper";
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
import { demo as findDemo, type Demo } from "./demos";
import { copy } from "./showcase-copy";
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
/**
 * A command the playground started: Run's file or a demo's. `id` travels with its processes in
 * BUNWASM_LAUNCH_ID; `jobs` are the jobs those processes run in, for a forced Stop. `argument` is
 * what the echoed command names (a demo runs from ~ by file name, Run by absolute path).
 */
export type Launch = {
  readonly id: string;
  readonly path: string;
  readonly argument: string;
  readonly demo?: Demo;
  readonly jobs: Set<number>;
  /** Its command line has been submitted; Stop no longer just drops it. */
  sent: boolean;
  /** Stop already sent Ctrl-C once; the next Stop kills. */
  interrupted: boolean;
};
type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly cancel: AbortController }
  | { readonly kind: "launched"; readonly launch: Launch };

/** The environment variable that carries a launch's id into its processes. */
const LAUNCH_ENV = "BUNWASM_LAUNCH_ID";
const SIGKILL = 9;

function newLaunch(path: string, demo?: Demo): Launch {
  const id = crypto.randomUUID().slice(0, 8);
  return { id, path, argument: demo ? path.slice(HOME.length + 1) : path, demo, jobs: new Set(), sent: false, interrupted: false };
}

function launchSubcommand(path: string): string {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ? "test" : "run";
}

/** Quotes for the shell only when needed, so ordinary file names echo as typed. */
function shellWord(word: string): string {
  return /^[\w./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}
export type Pane = "code" | "preview" | "terminal";
const encoder = new TextEncoder();
/** WASI EEXIST, as the filesystem worker reports an exclusive create of an existing path. */
const ERRNO_EXIST = 20;

function isExistsError(error: unknown): boolean {
  return !!error && typeof error === "object" && "errno" in error && error.errno === ERRNO_EXIST;
}
/** Why Run became Reload. Startup and ownership failures also lock the workspace controls. */
export type Failure = "startup" | "ownership" | "shell";

const DEFAULT_ENGINE: Engine = "browser";
const HOST_VERSIONS = {};
const STOP_WAIT_MS = 30_000;
/** A demo click stops the running command first; a second interrupt after this long sends SIGKILL. */
const DEMO_INTERRUPT_MS = 3_000;
const DEMO_IDLE_MS = 15_000;
/** The welcome banner wraps at words, at most this wide (narrower on phones). */
const BANNER_COLUMNS = 60;

/** The playground page: one Waffle runtime, the ~ workspace, bun.wasm, and an interactive bash-web shell. */
export class Playground extends TypedEventTarget<{ change: Event }> {
  readonly tabId = crypto.randomUUID();
  readonly engine: Engine;
  readonly profile: PlaygroundProfile;
  private readonly requestedProfile: PlaygroundProfile | undefined;
  readonly template: ProjectTemplate | undefined;
  /** The demo the visitor last started; `?demo=<id>` starts one when the page is ready. */
  activeDemo: Demo | undefined;
  /** A server started in the examples workspace, shown docked next to the terminal. */
  dockedPreview: { url: string; port: number; key: number; launch: Launch | undefined } | undefined;
  /** The pane a phone shows in the examples workspace. */
  pane: Pane = "code";
  /** Who owns the foreground: nothing, a demo or Restart preparing, or a launch the playground submitted. */
  private phase: Phase = { kind: "idle" };
  /** Launch submissions still in flight (including a stopped one that has not reached its prompt). */
  private submitting = 0;
  /** The playground launch each Bun process's network helper belongs to, recorded at process start. */
  private readonly helperLaunches = new WeakMap<RuntimeNetworkHelper, Launch>();
  /** Launches that own the foreground now, by id, for attribute(). */
  private readonly liveLaunches = new Map<string, Launch>();
  /** The launch whose submission is still in flight, even after a demo took the phase. */
  private lastLaunch: Launch | undefined;
  /** The `?demo=` request, read once at construction; startup runs it unless the visitor acted first. */
  private readonly startupDemo: Demo | undefined;
  /** Counts the visitor's own Run, Stop, demo and Restart presses. */
  private userActions = 0;
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
  private previewKey = 0;
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
    this.startupDemo = this.template ? undefined : findDemo(this.params.get("demo"));
    this.activeDemo = this.startupDemo;
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
    return this.ready && this.shellState === "ready" && this.phase.kind === "idle" && this.submitting === 0 && !this.shell?.running;
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

  /** A foreground command is running or about to: the Run button offers Stop. */
  get busy(): boolean {
    return this.ready && (this.phase.kind !== "idle" || this.shell?.running === true);
  }

  /** Saves the open file and runs it by absolute path. Resolves when the command ends. */
  async run(): Promise<void> {
    const { editor, shell } = this;
    if (!this.ready || !editor || !shell || shell.running || this.phase.kind !== "idle" || this.submitting > 0) return;
    this.userActions++;
    const launch = newLaunch(editor.path);
    this.setPhase({ kind: "launched", launch });
    try {
      await editor.save();
    } catch (error) {
      this.settle(launch);
      throw error;
    }
    await this.submitLaunch(launch);
  }

  /**
   * Stop: while a demo or Restart is still preparing (or a demo is still in its `cd ~`), cancel
   * it; otherwise Ctrl-C for the foreground command. A second Stop on a playground launch
   * kills its jobs with SIGKILL, so a program that handles SIGINT still stops.
   */
  stop(): void {
    this.userActions++;
    const { phase } = this;
    if (phase.kind === "preparing") phase.cancel.abort();
    if (phase.kind === "preparing" || (phase.kind === "launched" && !phase.launch.sent)) {
      this.setPhase({ kind: "idle" });
      this.shell?.interrupt();
      return;
    }
    if (phase.kind === "launched" && phase.launch.interrupted) {
      void this.forceStop(phase.launch).catch(this.report);
      return;
    }
    if (phase.kind === "launched") phase.launch.interrupted = true;
    this.shell?.interrupt();
  }

  /** SIGKILL for every job the launch's processes run in; Waffle records 137 for each. */
  private async forceStop(launch: Launch): Promise<void> {
    const { runtime } = this;
    if (!runtime || launch.jobs.size === 0) {
      this.shell?.interrupt();
      return;
    }
    const processes = await runtime.processes();
    await Promise.all(Array.from(launch.jobs, job => processes.killJob(job, SIGKILL)));
  }

  /** Every phase change re-renders, since Run, Stop and the demo buttons all read it. */
  private setPhase(phase: Phase): void {
    if (this.phase.kind === "launched" && phase !== this.phase) this.liveLaunches.delete(this.phase.launch.id);
    if (phase.kind === "launched") {
      this.liveLaunches.set(phase.launch.id, phase.launch);
      this.lastLaunch = phase.launch;
    }
    this.phase = phase;
    this.changed();
  }

  /** Returns to idle if `launch` still owns the foreground. */
  private settle(launch: Launch): void {
    if (this.phase.kind !== "launched" || this.phase.launch !== launch) return;
    this.setPhase({ kind: "idle" });
  }

  /**
   * Submits `launch` tagged with its id in BUNWASM_LAUNCH_ID, which its processes inherit (see
   * attribute()). A demo first runs `cd ~` and exports the id, then clears the screen, so it
   * echoes a short `bun run serve.ts` and its prompt starts from a zero exit status. Run puts
   * the id on its own command line.
   */
  private async submitLaunch(launch: Launch): Promise<void> {
    const { shell } = this;
    this.submitting++;
    try {
      if (!shell) return;
      const command = `bun ${launchSubcommand(launch.path)} ${shellWord(launch.argument)}`;
      if (launch.demo) {
        await shell.submit(`cd ~ && export ${LAUNCH_ENV}=${launch.id}`);
        await this.clearTerminal();
      }
      if (this.phase.kind !== "launched" || this.phase.launch !== launch) return;
      launch.sent = true;
      await shell.submit(launch.demo ? command : `${LAUNCH_ENV}=${launch.id} ${command}`);
    } finally {
      this.submitting--;
      if (this.lastLaunch === launch) this.lastLaunch = undefined;
      this.settle(launch);
      // canRun also depends on `submitting`, which settle() does not cover when Stop already
      // returned the phase to idle.
      this.changed();
    }
  }

  private clearTerminal(): Promise<void> {
    const { term } = this;
    if (!term) return Promise.resolve();
    return new Promise(resolve => term.write("", () => { term.clear(); resolve(); }));
  }

  /** Demos can start while a command runs: the running command (often a server) is stopped first. */
  get canStartDemo(): boolean {
    const shellUp = this.shellState === "ready" || this.shellState === "running";
    return this.ready && shellUp && this.phase.kind !== "preparing" && this.failure === undefined;
  }

  /**
   * Stops the foreground command, creates the demo's missing files (an existing file is the
   * visitor's and is never rewritten), opens its file and runs it from ~.
   */
  async runDemo(demo: Demo): Promise<void> {
    this.userActions++;
    await this.startDemo(demo);
  }

  private async startDemo(demo: Demo): Promise<void> {
    const { editor } = this;
    if (!this.canStartDemo || !editor) return;
    this.activeDemo = demo;
    this.syncDemoParam(demo);
    const path = `${HOME}/${demo.file}`;
    await this.prepareLaunch(newLaunch(path, demo), async (signal) => {
      for (const name of demo.files) {
        if (signal.aborted) return;
        await this.createIfMissing(`${HOME}/${name}`, encoder.encode(examples[name]!));
      }
      if (signal.aborted) return;
      await editor.open(path);
      if (signal.aborted) return;
      if (editor.path === path && editor.dirty(path)) await editor.save();
      this.pane = "terminal";
    });
  }

  /** Restart in the preview bar: reruns the launch that started the previewed server. */
  async restartPreview(): Promise<void> {
    const launch = this.dockedPreview?.launch;
    const { editor } = this;
    if (!launch || !editor || !this.canStartDemo) return;
    this.userActions++;
    if (launch.demo) return this.startDemo(launch.demo);
    await this.prepareLaunch(newLaunch(launch.path), async () => {
      if (editor.path === launch.path && editor.dirty(launch.path)) await editor.save();
    });
  }

  /**
   * The one way a demo or Restart takes the foreground: it stops what runs, prepares while Run
   * and other demos stay out (Stop cancels it), then submits its own launch.
   */
  private async prepareLaunch(launch: Launch, prepare: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const { shell } = this;
    if (!shell || this.phase.kind === "preparing") return;
    const cancel = new AbortController();
    const phase: Phase = { kind: "preparing", cancel };
    this.setPhase(phase);
    try {
      await this.stopForeground(shell, cancel.signal);
      if (cancel.signal.aborted) return;
      await prepare(cancel.signal);
      if (cancel.signal.aborted || !this.owns(phase)) return;
      this.setPhase({ kind: "launched", launch });
      // The launch resolves when the command ends, which for a server is when it is stopped.
      void this.submitLaunch(launch).catch(this.report);
    } finally {
      if (this.owns(phase)) this.setPhase({ kind: "idle" });
    }
  }

  /** The phase may change while awaiting (Stop, another launch), so read it fresh. */
  private owns(phase: Phase): boolean {
    return this.phase === phase;
  }

  /**
   * Attributes a starting Bun process to the live playground launch whose id it inherited in
   * BUNWASM_LAUNCH_ID. Only the launch's own command carries its id, so a server started by any
   * other process, such as a background job typed in the terminal, gets no Restart.
   */
  private attribute(helper: RuntimeNetworkHelper, process: BunProcessStart): void {
    const id = process.env[LAUNCH_ENV];
    const launch = id === undefined ? undefined : this.liveLaunches.get(id);
    if (!launch) return;
    this.helperLaunches.set(helper, launch);
    launch.jobs.add(process.job);
  }

  /** Phones show one pane at a time in the examples workspace. */
  setPane(pane: Pane): void {
    this.pane = pane;
    this.changed();
  }

  /** Creates `path` holding `bytes` unless it already exists. The check and create are one filesystem call. */
  private async createIfMissing(path: string, bytes: Uint8Array): Promise<boolean> {
    return this.withPlaygroundPageWrite(async (fs) => {
      const client = new FilesystemClient(fs.fork());
      try {
        await client.asyncCall("writeFile", [path, false, true], bytes);
        await fs.flush(path);
        return true;
      } catch (error) {
        if (isExistsError(error)) return false;
        throw error;
      } finally {
        client.dispose();
      }
    });
  }

  /** Interrupts the foreground command, then kills it if it ignores the interrupt. Stop ends the wait. */
  private async stopForeground(shell: BrowserSession, signal: AbortSignal): Promise<void> {
    const idle = () => signal.aborted || (!shell.running && this.submitting === 0);
    if (idle()) return;
    shell.interrupt();
    if (await waitUntil(idle, DEMO_INTERRUPT_MS)) return;
    const foreground = this.lastLaunch;
    if (foreground) await this.forceStop(foreground);
    else shell.interrupt();
    if (!await waitUntil(idle, DEMO_IDLE_MS)) throw new Error("The running command did not stop. Press Ctrl-C in the terminal, then try again.");
  }

  /** Keeps `?demo=` in the address so a copied link opens the same demo. */
  private syncDemoParam(demo: Demo): void {
    const next = new URL(location.href);
    next.searchParams.set("demo", demo.id);
    history.replaceState(history.state, "", next);
  }

  /**
   * Each announcement gets a fresh frame, so a restarted server is loaded again. `launch` is the
   * playground launch whose process opened the port (see attribute()); a server from any other
   * process has none, so its preview offers no Restart.
   */
  private dockPreview(url: string, port: number, launch: Launch | undefined): void {
    this.dockedPreview = { url, port, key: ++this.previewKey, launch };
    if (launch?.demo) this.pane = "preview";
    this.changed();
  }

  closePreview(): void {
    this.dockedPreview = undefined;
    if (this.pane === "preview") this.pane = "terminal";
    this.changed();
  }

  async newFile(name: string): Promise<void> {
    const { editor } = this;
    if (!editor || !this.fs) return;
    const path = normalize(name, HOME);
    await this.createIfMissing(path, new Uint8Array());
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
      !anyRollbackFailed &&
      (initialFs?.state.status === "disposed" || initialFs?.state.status === "failed") &&
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
      if (startedShell) {
        if (this.shell === startedShell) this.shell = undefined;
        retiring ??= startedShell.dispose().catch(() => {});
      }
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
    const announcedPorts = new Set<number>();
    this.disposePreviewLinks = installPreviewLinks(term, previews, previewPorts, () => this.editor?.focus());

    const announcePort = async (port: number, token: symbol) => {
      while (true) {
        const state = await previews.waitUntilRegistered(port, token);
        if (this.disposed || !previews.hasListener(port, token)) return;
        const rec = activePreviewTokens.get(port);
        if (!rec || rec.token !== token) return;
        if (state === "ready" && !previews.isListenerReady(port, token)) continue;
        rec.printed = state === "ready";
        // One server can register its port more than once (one per listener); announce it once.
        if (state === "ready" && announcedPorts.has(port)) return;
        if (state === "ready") announcedPorts.add(port);
        term.write(previewLine(previews, port, state));
        if (state === "ready" && !this.template) this.dockPreview(previews.url(port), port, this.helperLaunches.get(rec.helper));
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
      started: (helper, process) => this.attribute(helper, process),
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
        if (previews.serves(port)) return;
        previewPorts.delete(port);
        announcedPorts.delete(port);
        if (this.dockedPreview?.port === port) this.closePreview();
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
    const seconds = (performance.now() / 1000).toFixed(1);
    this.setStatus(`bun.wasm ready · ${ENGINES[engine].name} · ${mb(size)} · started in ${seconds} s`, "ok");
    if (this.ready) this.afterReady();
  }

  /**
   * A `?demo=` link starts the demo it named at page load, unless the visitor already pressed
   * something; otherwise the first command's code loads while idle.
   */
  private afterReady(): void {
    const requested = this.startupDemo;
    if (!requested || this.userActions > 0) {
      whenIdle(warmFirstCommand);
      return;
    }
    void this.startDemo(requested).catch(this.report);
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
    ]) for (const wrapped of wrapWords(line, Math.min(BANNER_COLUMNS, term.cols - 1))) term.writeln(wrapped);
    term.writeln("");
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
    const { runtime, term, bootSignal, programsReady, sessionModule, promptModule, engineEnv, shellState, onStarted } = params;
    const [programs, { BrowserSession }, prompts] = await Promise.all([
      programsReady,
      sessionModule,
      promptModule,
    ]);
    if (this.attachEnabled) {
      const identity = this.getIdentity();
      if (!identity) throw new Error("Worker identity missing before shell start");
      this.shellClaimHandle = await acquireWriterClaim(this.workspaceName, identity, this.ownClaimIds, { signal: bootSignal });
    }
    const prompt = prompts?.createPrompt({
      filesystem: runtime.filesystem,
      versions: HOST_VERSIONS,
      file: true,
      logger: (message: string, error?: unknown) => console.warn(`[prompt] ${message}`, error ?? ""),
    });
    const shell = await BrowserSession.create({
      runtime,
      cwd: HOME,
      env: { ...engineEnv, HOME, USER: "user", PATH: `${ENGINE_BIN[this.engine]}:${programs.path}`, TERM: "xterm-256color", COLORTERM: "truecolor", TMPDIR: "/tmp", PS1: "$ " },
      cols: term.cols,
      rows: term.rows,
      wasmUrl: new URL("./programs/shell-engine.wasm", location.href),
      workerUrl: entryAssetUrl("./shell-worker.js"),
      lineEditor: { mode: "zsh" },
      prompt,
      onOutput: bytes => term.write(bytes),
      onState: shellState,
    });
    stage("shell-created");
    onStarted(shell);
    term.onResize(({ cols, rows }) => shell.resize(cols, rows));
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
      onAbandon: (cleanup) => this.onAbandon(cleanup),
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

/** Resolves true once `done()` holds, or false after `ms`. */
async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!done()) {
    if (performance.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
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
    fontSize: typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches ? 13 : 14,
    scrollback: 5000,
    theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#fbf0df", selectionBackground: "#3a3d4a" },
  });
}

/** The short `localhost:<port>` text links to the real preview URL. */
function previewLine(previews: Previews, port: number, state: string): string {
  if (state !== "ready") return `\x1b[2m[preview] port ${port}: preview transport is ${state}\x1b[0m\r\n`;
  const url = previews.url(port);
  return `\x1b[2m[${copy.terminal.previewLabel}]\x1b[0m \x1b]8;;${url}\x07\x1b[4;36mlocalhost:${port}\x1b[0m\x1b]8;;\x07 \x1b[2m${copy.terminal.previewHint}\x1b[0m\r\n`;
}

/** Hard-wraps at spaces so banner lines never break mid-word; ANSI colour codes take no width. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && visibleLength(candidate) > width) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  return lines.concat([line]);
}

/** Text width without SGR colour sequences (ESC [ ... m). */
export function visibleLength(text: string): number {
  return text.split("\x1b[").reduce((length, part, index) => length + (index === 0 ? part : part.replace(/^[0-9;]*m/, "")).length, 0);
}

function warmFirstCommand(): void {
  for (const chunk of commandChunks()) void fetch(chunk, { priority: "low" }).then(response => response.arrayBuffer()).catch(() => {});
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}
