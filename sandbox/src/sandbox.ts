import { TypedEventTarget } from "@remix-run/component";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createRuntime, openIdleWorkspace, storedWorkspaces, type Runtime } from "waffle";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind";
import { parseMemoryProfile, requireProfileEngine, type ProgramMemoryProfile } from "../../web/src/program-profile";
import { installBunSharedObjects } from "../../src/shared-objects";
import { BrowserPrograms } from "../../web/src/browser-programs";
import { ENGINES, type Engine, WasmMissing, isEngine, loadEngineProgram, mb, registerModuleScope } from "../../web/src/engine-loader";
import type { BunNetworkOptions, RuntimeNetworkHelper } from "../../web/src/net/helper";
import { Previews } from "../../web/src/preview";
import type { Run, RunHooks, RunOptions, RunResult } from "../../web/src/runner";
import { getVfsDescriptor, UNSAVED_CHANGES_LOST, WORKSPACE_TAKEN_OVER } from "../../web/src/shared-fs";
import { errorText, measureStartup } from "../../web/src/startup";
import { openTerminal } from "../../web/src/terminal-mount";
import { linkLocalUrls } from "../../web/src/terminal-links";
import { Editor } from "./editor";
import { StartupOutput } from "./startup-output";
import { loadTemplate } from "./template";
import { defaultTemplate, selectTemplate, type Template } from "./template-catalog";
import { isStorageFull, workspaceName } from "./workspace-policy";
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
/** The project's directory in the guest's filesystem. */
const APP = `${HOME}/app`;
const PORT = 5173;
const DEFAULT_ENGINE: Engine = "browser";

/** What exists once the page's runtime is built; construction can fail before it does. */
interface Workspace {
  runtime: Runtime;
  fs: Filesystem;
  browserPrograms: BrowserPrograms;
  editor: Editor;
  term: Terminal;
  // A QuickJS/JSC parent can launch Bun light, whose cyclic imports need the module scope too.
  moduleScope: Promise<boolean>;
}

interface Server {
  port: number;
  helper: RuntimeNetworkHelper;
}

/** One Waffle runtime installs the selected project and runs its dev script. */
export class Sandbox extends TypedEventTarget<{ change: Event }> {
  /** Each template has its own persistent workspace, shared across engine switches. */
  get template(): Template["id"] { return this.project.id; }
  readonly engine: Engine;
  readonly profile: ProgramMemoryProfile;
  failure?: Failure;
  resetting = false;
  storageNotice = "";
  /** Project files, relative to the app directory, as of the last listing. */
  files: string[] = [];
  serverState: ServerState = { text: "starting dev server…" };
  /** The preview's address once it has been up; the ↗ link keeps it after the server stops. */
  previewLink = "#";
  private readonly params: URLSearchParams;
  private readonly project: Template;
  private readonly fit = new FitAddon();
  private terminalOpened!: () => void;
  private readonly terminalOpen = new Promise<void>((resolve) => { this.terminalOpened = resolve; });
  private message: Status = { text: "", kind: "" };
  private started = false;
  private workspace?: Workspace;
  private storage?: WorkspaceStorage;
  private storageError = "";
  private startup?: Promise<void>;
  private frame?: HTMLIFrameElement;
  private filesRevision = 0;
  private readonly previews = new Previews();
  private wasm: Awaited<ReturnType<typeof loadEngineProgram>> | null = null;
  private engineLoading?: Promise<void>;
  private firstStart = true;
  private run: Run | null = null;
  private server: Server | null = null;
  private serverRevision = 0;
  private serverTiming = { started: 0, visibleStart: 0 };
  private readonly network: BunNetworkOptions = {
    listening: (port, helper) => {
      this.previews.register(port, helper);
      const server = this.server = { port, helper };
      measureStartup("dev-server", this.serverTiming.started);
      void this.showPreview(server, this.serverTiming.visibleStart).catch(this.report);
    },
    stopped: (port, helper) => {
      this.previews.unregister(port, helper);
      if (this.server?.helper !== helper) return;
      this.server = null;
      this.setServerState("down", "dev server stopped · press Restart");
    },
  };

  constructor(search: string) {
    super();
    this.params = new URLSearchParams(search);
    this.project = selectTemplate(this.params.get("template"));
    const requested = this.params.get("engine");
    if (requested !== null && !isEngine(requested)) throw new TypeError(`Unknown Bun engine: ${requested}`);
    this.engine = requested ?? DEFAULT_ENGINE;
    this.profile = parseMemoryProfile(this.params.get("profile"));
    requireProfileEngine(this.engine, this.profile);
  }

  get term(): Terminal | undefined {
    return this.workspace?.term;
  }

  get editor(): Editor | undefined {
    return this.workspace?.editor;
  }

  get status(): Status {
    if (this.workspace?.fs.ownershipLost) return { text: `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`, kind: "error" };
    if (this.storageError) return { text: this.storageError, kind: "error" };
    return this.message;
  }

  /** Builds the page's runtime, then starts the workspace and dev server in the background. */
  start(): void {
    if (this.startup) return;
    try {
      if (getVfsDescriptor(this.params.get("mode") ?? "fast").mode === "fast") {
        this.launchPersistent();
        return;
      }
      this.startWorkspace();
    } catch (error) { console.error(error); this.fail("construction", error); }
  }

  private startWorkspace(): void {
    let workspace: Workspace;
    try {
      workspace = this.workspace = this.construct();
    } catch (error) {
      console.error(error);
      this.fail("construction", error);
      return;
    }
    this.changed();
    void this.boot(workspace).catch((error) => { this.fail("startup", error); this.report(error); });
  }

  private launchPersistent(): void {
    const pending = this.startPersistent().catch(error => {
      this.failure = "storage";
      const action = this.canReloadStartup() ? "Retry reloads this page." : "Keep this page open and retry.";
      this.storageError = `Browser storage could not be opened or saved. Your workspace was kept. ${action} ${errorText(error)}`;
      this.changed();
      this.term?.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
    }).finally(() => { if (this.startup === pending) this.startup = undefined; });
    this.startup = pending;
  }

  private async startPersistent(): Promise<void> {
    const engine = this.wasm ? Promise.resolve() : this.loadEngine();
    this.setStatus("checking stored projects…");
    this.storage ??= await WorkspaceStorage.open({
      stored: () => storedWorkspaces("fast"),
      openIdle: (name, signal) => openIdleWorkspace({ mode: "fast", name }, { signal }),
    }, this.template, report => this.storageResult(report));
    await this.storage.prepare();
    const workspace = this.workspace ??= this.construct();
    this.changed();
    await this.boot(workspace, engine);
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
  async refreshFiles(): Promise<void> {
    if (!this.workspace) return;
    const revision = ++this.filesRevision;
    const paths = (await this.workspace.fs.listFiles(APP)).map(rel).filter((p) => !p.split("/").some((part) => part.startsWith(".")));
    if (revision !== this.filesRevision) return;
    this.files = paths;
    this.changed();
  }

  /** Flushes debounced edits before leaving; a failed save keeps this page open. */
  async navigate(param: "engine" | "template", value: string): Promise<void> {
    await this.editor?.flushAll();
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
      if (!this.started && this.workspace?.fs.state.status === "failed") {
        if (this.canReloadStartup()) location.reload();
        return;
      }
      this.failure = undefined;
      if (!this.started && getVfsDescriptor(this.params.get("mode") ?? "fast").mode === "fast") this.launchPersistent();
      else if (!this.started) this.startWorkspace();
      else void this.startDevServer().catch(this.report);
      return;
    }
    if (this.failure) { location.reload(); return; }
    if (!this.started) return;
    this.term?.write("\r\n");
    void this.startDevServer().catch(this.report);
  }

  private canReloadStartup(): boolean {
    const workspace = this.workspace;
    return !this.started && !!workspace && workspace.fs.state.status === "failed"
      && workspace.editor.path === "" && !workspace.editor.hasPending && workspace.editor.view.state.doc.length === 0;
  }

  async reset(): Promise<void> {
    const { workspace } = this;
    if (!workspace) return;
    this.resetting = true;
    this.changed();
    try {
      workspace.editor.discard();
      const current = this.run;
      this.stopDevServer();
      await current?.done;
      await workspace.editor.waitForSaves();
      const replace = () => loadTemplate(workspace.fs, APP, this.project.file, true).then(() => {});
      if (this.storage) await this.storage.reset(replace);
      else await replace();
      location.reload();
    } catch (error) {
      this.resetting = false;
      this.report(error);
    }
  }

  readonly report = (error: unknown): void => {
    if (isStorageFull(error) || error instanceof PreservationRefused) {
      this.failure = "storage";
      this.storageError = `Browser storage could not be saved. Keep this page open and copy any unsaved text. No active project was removed. ${errorText(error)}`;
    }
    this.setStatus(errorText(error), "error");
    this.term?.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
  };

  private changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  private setStatus(text: string, kind: Status["kind"] = ""): void {
    this.message = { text, kind };
    this.changed();
  }

  private fail(failure: Failure, error: unknown): void {
    this.failure = failure;
    this.setStatus(errorText(error), "error");
  }

  private setServerState(state: NonNullable<ServerState["state"]>, text: string, url?: string): void {
    this.serverState = { state, text, url };
    if (url) this.previewLink = url;
    this.changed();
  }

  private construct(): Workspace {
    const mode = getVfsDescriptor(this.params.get("mode") ?? "fast").mode;
    const runtime = createRuntime({ filesystem: { mode, name: workspaceName(this.template) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
    const sharedObjects = installBunSharedObjects(runtime);
    addEventListener("pagehide", (event: PageTransitionEvent) => { if (!event.persisted) sharedObjects.close(); });
    const fs = runtime.filesystem;
    const browserPrograms = new BrowserPrograms(runtime, {
      worker: new URL("./preview1-worker.js", location.href),
      shell: new URL("./programs/shell-engine.wasm", location.href),
      shellWorker: new URL("./shell-worker.js", location.href),
    });
    addEventListener("pagehide", (event: PageTransitionEvent) => {
      if (event.persisted) return;
      this.storage?.close();
      void Promise.all([runtime.dispose(), browserPrograms.dispose()]).catch(console.error);
    });
    fs.onOwnershipLost = () => this.fail("startup", "");
    const term = createTerminal();
    term.loadAddon(this.fit);
    linkLocalUrls(term, this.previews);
    const moduleScope = registerModuleScope();
    const editor = new Editor(fs, {
      app: APP,
      save: (path, text, revision) => this.save(fs, path, text, revision),
      checkpoint: () => this.retryStorage(() => fs.flush()),
      changed: () => this.changed(),
    });
    Object.assign(globalThis, {
      sandbox: { runtime, sharedObjects, fs, editor, term, restart: () => this.startDevServer(), server: () => this.server, started: () => this.started, engine: this.engine, profile: this.profile, template: this.template },
    });
    return { runtime, fs, browserPrograms, editor, term, moduleScope };
  }

  private async boot({ fs, editor }: Workspace, engine = this.loadEngine()): Promise<void> {
    await this.terminalOpen;
    await this.retryStorage(() => fs.mkdirp("/tmp"));
    this.setServerState("starting", "loading…");
    if (!globalThis.crossOriginIsolated) {
      this.setStatus("this page is not cross-origin isolated: the dev server can't serve previews", "error");
    }
    const seed = () => loadTemplate(fs, APP, this.project.file).then(() => {});
    const initialize = this.storage ? () => this.storage!.initialize(fs, seed) : seed;
    await Promise.all([this.retryStorage(initialize), engine]);
    this.storageError = "";
    if (this.resetting) return;
    await this.refreshFiles();
    const startFile = this.project.editorFile;
    await editor.open(await fs.lookup(abs(startFile)) ? startFile : ((await fs.listFiles(APP)).map(rel)[0] ?? startFile));
    if (!this.failure) this.started = true;
    this.startup = undefined;
    if (!this.wasm) return;
    this.setStatus(`starting the dev server on ${ENGINES[this.engine].name}…`);
    await this.startDevServer();
  }

  private loadEngine(): Promise<void> {
    if (this.wasm) return Promise.resolve();
    return this.engineLoading ??= this.downloadEngine().finally(() => { this.engineLoading = undefined; });
  }

  private async downloadEngine(): Promise<void> {
    try {
      this.wasm = await loadEngineProgram(this.engine, this.profile, (text) => this.setStatus(text), this.params.get("wasm") ?? undefined);
    } catch (err) {
      const missing = err instanceof WasmMissing;
      this.setStatus(missing ? `${ENGINES[this.engine].wasm} is not in this build` : `could not load bun.wasm: ${String(err)}`, "error");
      this.setServerState("down", "no engine");
    }
  }

  private async startDevServer(): Promise<void> {
    this.stopDevServer();
    const revision = this.serverRevision;
    const { wasm, workspace } = this;
    if (!wasm || !workspace) return;
    const { runtime, fs, browserPrograms, editor, term } = workspace;
    await editor.flushAll();
    if (revision !== this.serverRevision) return;
    const visibleStart = this.firstStart ? 0 : performance.now();
    this.firstStart = false;
    this.setStatus("waiting for module service worker…");
    const scoped = await workspace.moduleScope;
    if (revision !== this.serverRevision) return;
    await this.retryStorage(() => fs.flush());
    if (revision !== this.serverRevision) return;
    const programs = await browserPrograms.ready();
    if (revision !== this.serverRevision) return;
    const env: Record<string, string> = {
      HOME,
      PWD: APP,
      USER: "user",
      PATH: programs.path,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(term.cols),
      LINES: String(term.rows),
      TMPDIR: "/tmp",
      PORT: String(PORT),
      BUN_WASM_STARTUP: "1",
      // Output-only stdin is EOF. Vite must not treat it as a request to close the server.
      CI: "true",
    };
    await runtime.processes();
    if (revision !== this.serverRevision) return;
    const options = { engine: this.engine, profile: this.profile, module: wasm.module, env, runtime, moduleScope: scoped, network: this.network };
    const result = await this.retryStorage(() => this.command("install", options, visibleStart, revision));
    if (!result || result.code !== 0 || result.error || revision !== this.serverRevision) return;
    await this.retryStorage(() => fs.flush());
    this.storageError = "";
    if (revision !== this.serverRevision) return;
    await this.command("dev", options, visibleStart, revision);
  }

  private async command(script: "install" | "dev", options: Omit<RunOptions, "args">, visibleStart: number, revision: number): Promise<RunResult | undefined> {
    const { startRun } = await import("../../web/src/runner");
    if (revision !== this.serverRevision) return;
    const term = this.workspace!.term;
    const args = script === "install" ? ["install"] : ["run", "dev"];
    const message = script === "install" ? "installing dependencies…" : "starting dev server…";
    this.setStatus(message);
    this.setServerState("starting", message);
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
    const current = startRun({ ...options, args }, hooks);
    this.run = current;
    const result = await current.done;
    output.flush();
    if (result.error) term.write(`\x1b[31m${result.error}\x1b[0m\r\n`);
    if (this.run !== current) return;
    this.run = null;
    if (script === "install" && (storageFailed || isStorageFull(result.error))) throw new Error("Dependency installation ran out of storage", { cause: `ENOSPC\n${result.error ?? ""}\n${diagnostic}` });
    if (script === "install" && result.code === 0 && !result.error) return result;
    term.write(`\x1b[2m[${script} exited with code ${result.code}]\x1b[0m\r\n`);
    this.setServerState("down", `${script} stopped (exit ${result.code}) · press Restart`);
    return result;
  }

  private retryStorage<T>(operation: () => Promise<T>): Promise<T> {
    return this.storage ? this.storage.recovery.retry(operation) : operation();
  }

  private stopDevServer(): void {
    this.serverRevision++;
    const current = this.run;
    this.run = null;
    this.server = null;
    // Restart discards this Run handle, so request the force-stop action explicitly.
    current?.kill(9);
  }

  private async showPreview(target: Server, visibleStart: number): Promise<void> {
    const state = await this.previews.ready;
    if (this.server !== target) return;
    const { port } = target;
    if (state !== "ready") {
      this.setServerState("down", `previews need a service worker (${state} here)`);
      return;
    }
    const url = this.previews.url(port, "/");
    // The label shows the server's own address; tapping it opens the preview, which works anywhere.
    this.setServerState("up", `localhost:${port}/`, url);
    this.setStatus("loading preview…");
    const previewStarted = performance.now();
    const { frame } = this;
    if (!frame) return;
    frame.addEventListener("load", () => {
      if (this.server !== target) return;
      measureStartup("preview", previewStarted);
      this.setStatus(`dev server ready in ${((performance.now() - visibleStart) / 1000).toFixed(1)} s · ${ENGINES[this.engine].name} · ${mb(this.wasm?.size ?? 0)}`, "ok");
    }, { once: true });
    frame.src = url;
  }

  private async save(fs: Filesystem, path: string, text: string, revision: number): Promise<void> {
    try {
      await this.retryStorage(async () => { await fs.writeFile(abs(path), text); await fs.flush(abs(path)); });
    } catch (error) { this.report(error); throw error; }
    if (this.editor?.settle(revision, { text: "saved", kind: "ok" })) {
      const wasStorageFailure = this.storageError !== "" || this.failure === "storage";
      this.storageError = "";
      if (this.failure === "storage") this.failure = undefined;
      if (wasStorageFailure) this.changed();
    }
  }

}

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
