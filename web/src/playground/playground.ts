import { TypedEventTarget } from "@remix-run/component";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createRuntime, type Runtime } from "waffle";
import { ENGINE_BIN } from "../../../src/executable-paths";
import { BrowserPrograms } from "../browser-programs";
import { ENGINES, type Engine, WasmMissing, isEngine, loadWasm, mb, registerModuleScope } from "../engine-loader";
import { HOME, examples } from "../examples";
import { normalize } from "../fs";
import { HostedPreviews } from "../hosted-previews";
import type { BunNetworkOptions } from "../net/helper";
import { Previews } from "../preview";
import { installRuntimeSharedObjects } from "../shared-objects/runtime";
import { getVfsDescriptor, UNSAVED_CHANGES_LOST, WORKSPACE_TAKEN_OVER } from "../shared-fs";
import type { BrowserSession, SessionState } from "bash-web/session";
import { errorText } from "../startup";
import { commandChunks } from "../startup-cache";
import { openTerminal } from "../terminal-mount";
import { linkLocalUrls } from "../terminal-links";
import { Editor } from "./editor";

type Filesystem = Runtime["filesystem"];
export type Status = { text: string; kind: "" | "ok" | "error" };
/** Why Run became Reload. Startup and ownership failures also lock the workspace controls. */
export type Failure = "startup" | "ownership" | "shell";

// The default (browser) runs the program in the browser's own JS engine, with bun-browser.wasm for
// the transpiler and natives; ?engine=quickjs and ?engine=jsc run the whole runtime in wasm.
const DEFAULT_ENGINE: Engine = "browser";
// The guest does not expose an admitted Bun version to this page, so the prompt must not guess one.
const HOST_VERSIONS = {};

/** The playground page: one Waffle runtime, the ~ workspace, bun.wasm, and an interactive bash-web shell. */
export class Playground extends TypedEventTarget<{ change: Event }> {
  readonly engine: Engine;
  term?: Terminal;
  editor?: Editor;
  failure?: Failure;
  /** Startup finished with the workspace still owned by this tab. */
  ready = false;
  private readonly params: URLSearchParams;
  private readonly fit = new FitAddon();
  private terminalOpened!: () => void;
  private readonly terminalOpen = new Promise<void>((resolve) => { this.terminalOpened = resolve; });
  private fs?: Filesystem;
  private shell?: BrowserSession;
  private shellState: SessionState = "starting";
  private runPending = false;
  private message: Status = { text: "", kind: "" };

  constructor(search: string) {
    super();
    this.params = new URLSearchParams(search);
    const requested = this.params.get("engine");
    this.engine = isEngine(requested) ? requested : DEFAULT_ENGINE;
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
      console.error(error);
      this.message = { text: errorText(error), kind: "error" };
      this.failure = "startup";
      this.changed();
    }
  }

  openTerminal(term: Terminal, node: HTMLElement, signal: AbortSignal): void {
    openTerminal(term, this.fit, node, signal);
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
    if (!editor || !shell || shell.running || this.runPending) return;
    this.runPending = true;
    this.changed();
    try {
      const path = editor.path;
      await editor.save();
      const quoted = `'${path.replace(/'/g, "'\\''")}'`;
      // Test files run under Bun's test runner, like `bun test <file>` would.
      const command = /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ? "test" : "run";
      await shell.submit(`bun ${command} ${quoted}`);
    } finally {
      this.runPending = false;
      this.changed();
    }
  }

  async newFile(name: string): Promise<void> {
    const { editor, fs } = this;
    if (!editor || !fs) return;
    const path = normalize(name, HOME);
    if (!await fs.lookup(path)) await fs.writeFile(path, "");
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
    this.message = { text, kind };
    this.changed();
  }

  private async boot(): Promise<void> {
    const mode = getVfsDescriptor(this.params.get("mode") ?? "fast").mode;
    const runtime = createRuntime({ filesystem: { mode, name: "bun-wasm-workspace" } });
    const browserPrograms = new BrowserPrograms(runtime, {
      worker: new URL("./preview1-worker.js", location.href),
      shell: new URL("./programs/shell-engine.wasm", location.href),
      shellWorker: new URL("./shell-worker.js", location.href),
    });
    const sharedObjects = installRuntimeSharedObjects(runtime);
    addEventListener("pagehide", (event: PageTransitionEvent) => { if (!event.persisted) sharedObjects.close(); });
    const fs = this.fs = runtime.filesystem;
    fs.onStateChange = state => {
      if (state.status === "waiting") this.setStatus("Waiting for this workspace to close in another tab. It will open here automatically.");
    };
    fs.onOwnershipLost = () => {
      this.failure = "ownership";
      this.changed();
    };
    await fs.mkdirp("/tmp");
    await seedExamples(fs);
    addEventListener("pagehide", (event: PageTransitionEvent) => {
      if (event.persisted) return;
      void Promise.all([runtime.dispose(), browserPrograms.dispose()]).catch(console.error);
    });

    const wasmReady = this.loadEngine();
    const promptModule = this.params.get("prompt") === "off" ? undefined : import("bash-web/prompt");
    // Browser-engine children need the module scope even when their parent uses QuickJS or JSC.
    const moduleScope: Promise<boolean> = registerModuleScope();
    // Networking needs SharedArrayBuffer: without cross-origin isolation bun.wasm gets no fetch slots.
    const previews = this.params.has("root-previews") ? new HostedPreviews(() => runtime) : new Previews();
    const term = this.term = createTerminal();
    term.loadAddon(this.fit);
    const network: BunNetworkOptions = {
      listening: (port, helper) => { previews.register(port, helper); void previews.ready.then(state => term.write(previewLine(previews, port, state))); },
      stopped: (port, helper) => previews.unregister(port, helper),
    };
    linkLocalUrls(term, previews);
    const editor = this.editor = new Editor(fs, { run: () => this.run(), report: this.report, changed: () => this.changed() });
    this.changed();
    await this.terminalOpen;
    await editor.open(editor.path);

    const storage = fs.vfs.persistent ? "persistent browser storage" : "memory-only browser storage";
    const durability = fs.vfs.persistent ? "survive" : "do not survive";
    for (const line of [
      "\x1b[1mBun in your browser\x1b[0m: bun.wasm (wasm32-wasip1) in a Web Worker.",
      "Try \x1b[32mbun repl\x1b[0m, \x1b[32mbun run index.ts\x1b[0m, or press Run.",
      `filesystem: ${storage}, preopened at /, cwd ${HOME}; editor saves ${durability} reload`,
      "",
    ]) term.writeln(line);

    const [programs, scoped, wasm] = await Promise.all([browserPrograms.ready(), moduleScope, wasmReady]);
    if (wasm instanceof Error) throw wasm;
    const module = wasm.module;
    const engine = this.engine;
    const bin = ENGINE_BIN[engine];
    const removeAdapter = runtime.registerAdapter(`bun:${engine}`, async (context, service) => {
      const { bunLauncher } = await import("../bun-launcher");
      return bunLauncher(engine, {
        runtime, network, workerUrl: new URL(scoped ? "./__bunwasm/worker.js" : "./worker.js", location.href).href,
        // web/build.ts emits the notification helper at the page root in both modes.
        notificationWorkerUrl: new URL("./notification-worker.js", location.href).href,
        loadTools: () => loadWasm("bun-tools.wasm", () => {}).then(loaded => loaded.module),
      })(context, service);
    });
    const removePrograms: Array<() => void> = [];
    for (const name of ["bun", "node", "nodejs"]) {
      const path = `${bin}/${name}`;
      removePrograms.push(runtime.registerProgram(path, { adapter: `bun:${engine}`, cooperative: true, module: () => module }));
      await fs.mkdirp(bin);
      await fs.writeFile(path, "bun-wasm registered executable\n");
    }
    await fs.flush();
    const { BrowserSession } = await import("bash-web/session");
    const prompt = (await promptModule)?.createPrompt({
      filesystem: runtime.filesystem,
      versions: HOST_VERSIONS,
      file: true,
      logger: (message, error) => console.warn(`[prompt] ${message}`, error ?? ""),
    });
    const shell = this.shell = await BrowserSession.create({
      runtime, cwd: HOME,
      env: { HOME, USER: "user", PATH: `${bin}:${programs.path}`, TERM: "xterm-256color", COLORTERM: "truecolor", TMPDIR: "/tmp", PS1: "$ " },
      cols: term.cols, rows: term.rows,
      wasmUrl: new URL("./programs/shell-engine.wasm", location.href),
      workerUrl: new URL("./shell-worker.js", location.href),
      lineEditor: { mode: "zsh" },
      prompt,
      onOutput: bytes => term.write(bytes),
      onState: (state, detail) => this.shellChanged(state, detail),
    });
    term.onData(data => shell.input(data));
    term.onResize(({ cols, rows }) => shell.resize(cols, rows));
    addEventListener("pagehide", (event: PageTransitionEvent) => {
      if (event.persisted) return;
      void shell.dispose().finally(() => {
        for (const remove of removePrograms) remove();
        removeAdapter();
      }).catch(console.error);
    });

    Object.assign(globalThis, { playground: { runtime, fs, shell, term, editor, previews } });
    this.ready = !fs.ownershipLost;
    this.setStatus(`bun.wasm ready · ${ENGINES[engine].name} · ${mb(wasm.size)}`, "ok");
    if (this.ready) whenIdle(warmFirstCommand);
  }

  private async loadEngine(): Promise<Awaited<ReturnType<typeof loadWasm>> | Error> {
    const wasmUrl = this.params.get("wasm") ?? ENGINES[this.engine].wasm;
    try {
      return await loadWasm(wasmUrl, (text) => this.setStatus(text));
    } catch (err) {
      const { script, wasm } = ENGINES[this.engine];
      return new Error(err instanceof WasmMissing
        ? `${wasmUrl} is not in this build. Build it with ${script} (dist/${wasm}), then rebuild web/.`
        : `could not load bun.wasm: ${String(err)}`);
    }
  }

  private shellChanged(state: SessionState, detail?: string): void {
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

function createTerminal(): Terminal {
  return new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
    fontSize: window.matchMedia("(max-width: 800px)").matches ? 13 : 14,
    scrollback: 5000,
    theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#fbf0df", selectionBackground: "#3a3d4a" },
    // OSC 8 hyperlinks open in a new tab.
    linkHandler: { activate: (_event, uri) => void window.open(uri, "_blank", "noopener"), allowNonHttpProtocols: false },
  });
}

function previewLine(previews: Previews, port: number, state: string): string {
  if (state !== "ready") return `\x1b[2m[preview] port ${port}: preview transport is ${state}\x1b[0m\r\n`;
  const url = previews.url(port);
  return `\x1b[2m[preview]\x1b[0m \x1b]8;;${url}\x07\x1b[4;36m${url}\x1b[0m\x1b]8;;\x07 \x1b[2m(Ctrl-C stops the server)\x1b[0m\r\n`;
}

// Prefetch the lazy Bun launcher and worker chunks for the first Bun command.
// Fetch only: importing here would turn deferred execution setup into startup work.
function warmFirstCommand(): void {
  for (const chunk of commandChunks()) void fetch(chunk, { priority: "low" }).then(response => response.arrayBuffer()).catch(() => {});
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}
