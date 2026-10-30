import { TypedEventTarget } from "@remix-run/component";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createRuntime, type Runtime } from "waffle";
import { BrowserPrograms } from "../../web/src/browser-programs";
import { ENGINES, type Engine, WasmMissing, isEngine, loadWasm, mb, registerModuleScope } from "../../web/src/engine-loader";
import { decode } from "../../web/src/fs";
import type { BunNetworkOptions, RuntimeNetworkHelper } from "../../web/src/net/helper";
import { Previews } from "../../web/src/preview";
import type { Run } from "../../web/src/runner";
import { getVfsDescriptor, UNSAVED_CHANGES_LOST, WORKSPACE_TAKEN_OVER } from "../../web/src/shared-fs";
import { errorText, measureStartup } from "../../web/src/startup";
import { openTerminal } from "../../web/src/terminal-mount";
import { linkLocalUrls } from "../../web/src/terminal-links";
import { depsCacheKey, readDeps, writeDeps } from "./deps-cache";
import { Editor } from "./editor";
import { StartupOutput } from "./startup-output";
import { dependenciesChanged, loadTemplate, type TemplateSources } from "./template";

type Filesystem = Runtime["filesystem"];
export type Status = { text: string; kind: "" | "ok" | "error" };
export type Template = "react" | "vanilla";
/** No state until startup reaches the dev server. */
export type ServerState = { state?: "starting" | "up" | "down"; text: string; url?: string };
/** Why Restart became Reload; any failure locks the workspace controls. */
export type Failure = "construction" | "startup";

const HOME = "/home/user";
/** The project's directory in the guest's filesystem. */
const APP = `${HOME}/app`;
const PORT = 5173;
const DEFAULT_ENGINE: Engine = "browser";
const DEPS_PATH = "/.bunwasm/deps-cache";

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
  updates: Promise<void>;
}

/** The sandbox page: one Waffle runtime, the template workspace, and `bun ./index.html` serving the preview. */
export class Sandbox extends TypedEventTarget<{ change: Event }> {
  /** Each template has its own persistent workspace, shared across engine switches. */
  readonly template: Template;
  readonly engine: Engine;
  failure?: Failure;
  resetting = false;
  /** Project files, relative to the app directory, as of the last listing. */
  files: string[] = [];
  serverState: ServerState = { text: "starting dev server…" };
  /** The preview's address once it has been up; the ↗ link keeps it after the server stops. */
  previewLink = "#";
  private readonly params: URLSearchParams;
  private readonly templateFile: string;
  private readonly fit = new FitAddon();
  private terminalOpened!: () => void;
  private readonly terminalOpen = new Promise<void>((resolve) => { this.terminalOpened = resolve; });
  private message: Status = { text: "", kind: "" };
  private started = false;
  private workspace?: Workspace;
  private frame?: HTMLIFrameElement;
  private templateSources: TemplateSources = {};
  private filesRevision = 0;
  private readonly previews = new Previews();
  private wasm: Awaited<ReturnType<typeof loadWasm>> | null = null;
  private firstStart = true;
  private depsKey: string | null = null;
  private run: Run | null = null;
  private server: Server | null = null;
  private serverRevision = 0;
  private serverTiming = { started: 0, visibleStart: 0 };
  /** Saved while the dev server was starting (before it listens): sent once it listens. */
  private readonly unsent = new Map<string, number>();
  private readonly network: BunNetworkOptions = {
    listening: (port, helper) => {
      this.previews.register(port, helper);
      const server = this.server = { port, helper, updates: Promise.resolve() };
      measureStartup("dev-server", this.serverTiming.started);
      void this.showPreview(server, this.serverTiming.visibleStart).catch(this.report);
      for (const [path, revision] of this.unsent) void this.sendUpdate(path, revision);
      this.unsent.clear();
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
    this.template = this.params.get("template") === "vanilla" ? "vanilla" : "react";
    this.templateFile = this.template === "vanilla" ? "template-vanilla.json" : "template.json";
    const requested = this.params.get("engine");
    this.engine = isEngine(requested) ? requested : DEFAULT_ENGINE;
  }

  get term(): Terminal | undefined {
    return this.workspace?.term;
  }

  get editor(): Editor | undefined {
    return this.workspace?.editor;
  }

  get status(): Status {
    if (this.workspace?.fs.ownershipLost) return { text: `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`, kind: "error" };
    return this.message;
  }

  /** Builds the page's runtime, then starts the workspace and dev server in the background. */
  start(): void {
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
    const fallback = param === "engine" ? DEFAULT_ENGINE : "react";
    if (value === fallback) next.searchParams.delete(param);
    else next.searchParams.set(param, value);
    if (param === "engine") next.searchParams.delete("wasm");
    location.assign(next);
  }

  restart(): void {
    if (this.failure) { location.reload(); return; }
    if (!this.started) return;
    this.term?.write("\r\n");
    void this.startDevServer().catch(this.report);
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
      await loadTemplate(workspace.fs, APP, this.templateFile, true);
      location.reload();
    } catch (error) {
      this.resetting = false;
      this.report(error);
    }
  }

  readonly report = (error: unknown): void => {
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
    const runtime = createRuntime({ filesystem: { mode, name: `bun-wasm-sandbox-${this.template}` } });
    const fs = runtime.filesystem;
    const browserPrograms = new BrowserPrograms(runtime, {
      worker: new URL("./preview1-worker.js", location.href),
      shell: new URL("./programs/shell-engine.wasm", location.href),
      shellWorker: new URL("./shell-worker.js", location.href),
    });
    addEventListener("pagehide", (event: PageTransitionEvent) => {
      if (event.persisted) return;
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
      changed: () => this.changed(),
    });
    Object.assign(globalThis, {
      sandbox: { fs, editor, term, restart: () => this.startDevServer(), server: () => this.server, engine: this.engine, template: this.template },
    });
    return { runtime, fs, browserPrograms, editor, term, moduleScope };
  }

  private async boot({ fs, editor }: Workspace): Promise<void> {
    await this.terminalOpen;
    await fs.mkdirp("/tmp");
    this.setServerState("starting", "loading…");
    if (!globalThis.crossOriginIsolated) {
      this.setStatus("this page is not cross-origin isolated: the dev server can't serve previews", "error");
    }
    await Promise.all([
      loadTemplate(fs, APP, this.templateFile).then((sources) => { this.templateSources = sources; }),
      this.loadEngine(),
    ]);
    await this.refreshFiles();
    const startFile = this.template === "vanilla" ? "src/main.ts" : "src/App.tsx";
    await editor.open(await fs.lookup(abs(startFile)) ? startFile : ((await fs.listFiles(APP)).map(rel)[0] ?? startFile));
    if (!this.failure) this.started = true;
    if (!this.wasm) return;
    this.setStatus(`starting the dev server on ${ENGINES[this.engine].name}…`);
    await this.startDevServer();
  }

  private async loadEngine(): Promise<void> {
    const wasmUrl = this.params.get("wasm") ?? ENGINES[this.engine].wasm;
    try {
      this.wasm = await loadWasm(wasmUrl, (text) => this.setStatus(text));
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
    this.unsent.clear();
    for (const phase of ["deps-cached", "bundling-react", "bundled-react"]) {
      performance.clearMarks(`bunwasm:${phase}`);
      performance.clearMeasures(`bunwasm:${phase}`);
    }
    const changedDeps = await dependenciesChanged(fs, APP, this.templateSources);
    if (revision !== this.serverRevision) return;
    this.depsKey = changedDeps ? null : depsCacheKey(this.engine, wasm.build, this.templateFile);
    const cached = this.depsKey ? await readDeps(this.depsKey) : null;
    if (revision !== this.serverRevision) return;
    await fs.remove(DEPS_PATH);
    if (revision !== this.serverRevision) return;
    if (cached) await fs.writeFile(DEPS_PATH, cached);
    await fs.flush();
    if (revision !== this.serverRevision) return;
    this.setStatus("starting worker…");
    this.setServerState("starting", "starting dev server…");
    term.write(`\x1b[2m$\x1b[0m bun ./index.html \x1b[2m(${ENGINES[this.engine].name})\x1b[0m\r\n`);
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
    };
    const started = performance.now();
    const [{ startRun }] = await Promise.all([import("../../web/src/runner"), runtime.processes()]);
    if (revision !== this.serverRevision) return;
    const output = new StartupOutput((text) => term.write(text), startupRecord);
    this.serverTiming = { started, visibleStart };
    const current = startRun({ engine: this.engine, module: wasm.module, args: ["./index.html"], env, runtime, moduleScope: scoped, network: this.network }, {
      phase: (name) => {
        if (name === "worker-start") this.setStatus("starting dev server…");
      },
      stdout: (data) => output.write(data),
      stderr: (data) => output.write(data),
    });
    this.run = current;
    const result = await current.done;
    output.flush();
    if (result.error) term.write(`\x1b[31m${result.error}\x1b[0m\r\n`);
    if (this.run !== current) return; // restarted
    this.run = null;
    term.write(`\x1b[2m[dev server exited with code ${result.code}]\x1b[0m\r\n`);
    if (!this.server) this.setServerState("down", `dev server stopped (exit ${result.code}) · press Restart`);
  }

  private stopDevServer(): void {
    this.serverRevision++;
    const current = this.run;
    this.run = null;
    this.server = null;
    // Restart discards this Run handle, so request the force-stop action explicitly.
    current?.kill(9);
  }

  private async saveDeps(target: Server, key: string): Promise<void> {
    try {
      const result = await guestBytes(target, "/_bun/deps-cache");
      if (result.status !== 200 || this.server !== target || decode(result.bytes.subarray(0, 8)) !== "BUNDEPS1") return;
      await this.workspace?.fs.writeFile(DEPS_PATH, result.bytes);
      await writeDeps(key, result.bytes);
    } catch {
      // Restart can close the guest while the dependency cache is being saved.
    }
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
      if (this.depsKey) void this.saveDeps(target, this.depsKey);
      this.setStatus(`dev server ready in ${((performance.now() - visibleStart) / 1000).toFixed(1)} s · ${ENGINES[this.engine].name} · ${mb(this.wasm?.size ?? 0)}`, "ok");
    }, { once: true });
    frame.src = url;
  }

  private async sendUpdate(path: string, revision: number): Promise<void> {
    const target = this.server;
    if (!target) return;
    // The shared filesystem owns the bytes. Only wake HMR; replaying this save's
    // contents through changeFile could roll back a newer write already committed there.
    const update = target.updates.then(async () => {
      if (this.server === target) await target.helper.notifyFileChanged(abs(path));
    });
    target.updates = update.catch(() => {});
    try {
      await update;
      if (this.server === target) this.editor?.settle(revision, { text: "saved", kind: "ok" });
    } catch (error) {
      if (this.server === target) this.editor?.settle(revision, { text: `not sent: ${error instanceof Error ? error.message : String(error)}`, kind: "error" });
    }
  }

  private async save(fs: Filesystem, path: string, text: string, revision: number): Promise<void> {
    await fs.writeFile(abs(path), text);
    await fs.flush(abs(path));
    if (this.server) await this.sendUpdate(path, revision);
    else if (this.run) this.unsent.set(path, revision);
    else this.editor?.settle(revision, { text: "saved", kind: "ok" });
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

function guestBytes(target: Server, path: string): Promise<{ status: number; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let status = 0;
    const accepted = target.helper.request(target.port, {
      method: "GET", target: path, headers: [], body: new Uint8Array(),
    }, {
      head: (head) => { status = head.status; },
      data: (chunk) => { chunks.push(chunk.slice()); },
      end: () => {
        const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        resolve({ status, bytes });
      },
      error: (message) => reject(new Error(message)),
    });
    if (!accepted) reject(new Error("the dev server is not listening"));
  });
}
