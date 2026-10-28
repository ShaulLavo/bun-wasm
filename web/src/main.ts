import "@xterm/xterm/css/xterm.css";
import { showPageStartupFailure } from "./startup";
import "./style.css";

import { javascript } from "@codemirror/lang-javascript";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { basicSetup } from "codemirror";
import { HOME, examples } from "./examples";
import { decode, normalize } from "./fs";
import { createRuntime } from "waffle";
import { BrowserPrograms } from "./browser-programs";
import { getVfsDescriptor, WORKSPACE_TAKEN_OVER, UNSAVED_CHANGES_LOST } from "./shared-fs";
import type { BunNetworkOptions } from "./net/helper";
import { Previews } from "./preview";
import { HostedPreviews } from "./hosted-previews";
import { ENGINES as engines, type Engine, WasmMissing, isEngine, loadWasm as fetchWasm, mb, registerModuleScope } from "./engine-loader";
import type { Run } from "./runner";
import { type Output, Shell } from "./shell";
import { commandChunks } from "./startup-cache";
import { enableTerminalCopy } from "./terminal-copy";
import { linkLocalUrls } from "./terminal-links";
import { installRuntimeSharedObjects } from "./shared-objects/runtime";

async function main(): Promise<void> {
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $<HTMLSpanElement>("#status");
const runButton = $<HTMLButtonElement>("#run");
const engineSelect = $<HTMLSelectElement>("#engine");
const tabsEl = $<HTMLDivElement>("#tabs");
// Phones get a file dropdown instead of the tab strip, so nothing scrolls sideways.
const fileSelect = $<HTMLSelectElement>("#file-select");
const newFileButton = $<HTMLButtonElement>("#new-file");

const params = new URLSearchParams(location.search);
// The default (browser) runs the program in the browser's own JS engine, with bun-browser.wasm for
// the transpiler and natives; ?engine=quickjs and ?engine=jsc run the whole runtime in wasm.
const defaultEngine: Engine = "browser";
const requested = params.get("engine");
const engine: Engine = isEngine(requested) ? requested : defaultEngine;
const engineName = engines[engine].name;
const wasmUrl = params.get("wasm") ?? engines[engine].wasm;
const trace = params.has("trace");
const mode = getVfsDescriptor(params.get("mode") ?? "fast").mode;
const isolated = globalThis.crossOriginIsolated === true;
const sleepMode = isolated ? "Atomics.wait (cross-origin isolated)" : "busy-wait (page is not cross-origin isolated)";

engineSelect.value = engine;
engineSelect.addEventListener("change", () => {
  const next = new URL(location.href);
  if (engineSelect.value === defaultEngine) next.searchParams.delete("engine");
  else next.searchParams.set("engine", engineSelect.value);
  next.searchParams.delete("wasm");
  location.assign(next);
});

// Networking needs SharedArrayBuffer: without cross-origin isolation bun.wasm gets no fetch slots.
const previews = params.has("root-previews") ? new HostedPreviews(() => runtime) : new Previews();
const network: BunNetworkOptions = {
  listening: (port, helper) => { previews.register(port, helper); void previews.ready.then(state => term.write(previewLine(port, state))); },
  stopped: (port, helper) => previews.unregister(port, helper),
};

// ---------- filesystem ----------

let startup: "starting" | "ready" | "failed" = "starting";
runButton.onclick = () => {
  if (startup === "failed") { location.reload(); return; }
  if (startup === "ready") void runCurrent().catch(reportError);
};
runButton.disabled = true;
newFileButton.disabled = true;
engineSelect.disabled = true;
fileSelect.disabled = true;
const runtime = createRuntime({ filesystem: { mode, name: "bun-wasm-workspace" } });
const browserPrograms = new BrowserPrograms(runtime, {
  worker: new URL("./preview1-worker.js", location.href),
  shell: new URL("./programs/shell-engine.wasm", location.href),
  shellWorker: new URL("./shell-worker.js", location.href),
});
const sharedObjects = installRuntimeSharedObjects(runtime);
addEventListener("pagehide", (event: PageTransitionEvent) => { if (!event.persisted) sharedObjects.close(); });
const fs = runtime.filesystem;
fs.onStateChange = state => {
  if (state.status === "waiting") {
    setStatus("Waiting for this workspace to close in another tab. It will open here automatically.");
  }
};
fs.onOwnershipLost = () => {
  startup = "failed";
  setStatus("", "error");
  runButton.textContent = "Reload";
  runButton.disabled = false;
  runButton.title = "Open the latest saved workspace";
  newFileButton.disabled = true;
  engineSelect.disabled = true;
  fileSelect.disabled = true;
};
try {
  await fs.mkdirp("/tmp");
  // Background persistence can save a prefix of startup. Publish completion only after
  // every example is present; a missing marker retries an interrupted seed from scratch.
  // After completion, missing examples are intentional deletions and stay deleted.
  const initialized = `${HOME}/.bunwasm-initialized`;
  if (!await fs.lookup(initialized)) {
    await fs.remove(HOME);
    await fs.mkdirp(HOME);
    for (const [name, source] of Object.entries(examples)) await fs.writeFile(`${HOME}/${name}`, source);
    await fs.mkdirp(initialized);
    await fs.flush();
  }
} catch (error) {
  // The terminal is not initialized yet, but storage/lock failures must be visible.
  setStatus(String(error), "error");
  throw error;
}

// ---------- bun.wasm ----------


addEventListener("pagehide", (event: PageTransitionEvent) => {
  if (event.persisted) return;
  void Promise.all([runtime.dispose(), browserPrograms.dispose()]).catch(console.error);
});

let wasm: { module: WebAssembly.Module; size: number } | { error: string } | null = null;
// The final status waits for the page to finish setting up, so "ready" means usable.
let pageSetUp!: () => void;
const pageReady = new Promise<void>((resolve) => { pageSetUp = resolve; });
const wasmReady = loadWasm();

function setStatus(text: string, kind: "" | "ok" | "error" = ""): void {
  if (fs.ownershipLost) {
    text = `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`;
    kind = "error";
  }
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

async function loadWasm(): Promise<void> {
  try {
    const loaded = await fetchWasm(wasmUrl, (text) => setStatus(text));
    wasm = loaded;
    await pageReady;
    setStatus(`bun.wasm ready · ${engineName} · ${mb(loaded.size)}`, "ok");
  } catch (err) {
    const missing = err instanceof WasmMissing;
    const error = missing
      ? `${wasmUrl} is not in this build. Build it with ${engines[engine].script} (dist/${engines[engine].wasm}), then rebuild web/.`
      : `could not load bun.wasm: ${String(err)}`;
    wasm = { error };
    await pageReady;
    setStatus(missing ? "bun.wasm missing" : "bun.wasm failed to load", "error");
  }
}

// Browser-engine children need the module scope even when their parent uses QuickJS or JSC.
const moduleScope: Promise<boolean> = registerModuleScope();

let current: Run | null = null;

async function runBun(args: string[], cwd: string, io: Output): Promise<number> {
  const [{ startRun }, , , programs] = await Promise.all([import("./runner"), wasmReady, runtime.processes(), browserPrograms.ready()]);
  if (!wasm || "error" in wasm) {
    io.err(`\x1b[31m${wasm?.error ?? "bun.wasm unavailable"}\x1b[0m\r\n`);
    return 127;
  }
  const env: Record<string, string> = {
    HOME,
    PWD: cwd,
    USER: "user",
    PATH: programs.path,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(term.cols),
    LINES: String(term.rows),
    TMPDIR: "/tmp",
  };
  const scoped = await moduleScope;
  runButton.disabled = true;
  try {
    await fs.drain();
    const run = startRun({ engine, module: wasm.module, args, env, runtime, moduleScope: scoped, trace, network }, {
      stdout: (data) => io.out(data),
      stderr: (data) => io.err(data),
    });
    current = run;
    const result = await run.done;
    if (result.error) io.err(`\x1b[31m${result.error}\x1b[0m\r\n`);
    await editor.syncFromFs();
    return result.code;
  } finally {
    current = null;
    runButton.disabled = false;
  }
}

function previewLine(port: number, state: string): string {
  if (state !== "ready") return `\x1b[2m[preview] port ${port}: preview transport is ${state}\x1b[0m\r\n`;
  const url = previews.url(port);
  // OSC 8 hyperlink; the terminal's linkHandler opens it in a new tab.
  return `\x1b[2m[preview]\x1b[0m \x1b]8;;${url}\x07\x1b[4;36m${url}\x1b[0m\x1b]8;;\x07 \x1b[2m(Ctrl-C stops the server)\x1b[0m\r\n`;
}

function kill(): void {
  if (!current) return;
  term.write("^C\r\n");
  current.kill();
}

// ---------- terminal ----------

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  fontSize: window.matchMedia("(max-width: 800px)").matches ? 13 : 14,
  scrollback: 5000,
  theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#fbf0df", selectionBackground: "#3a3d4a" },
  linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
});
const fit = new FitAddon();
term.loadAddon(fit);
const termEl = $<HTMLDivElement>("#terminal");
term.open(termEl);
enableTerminalCopy(term, $<HTMLButtonElement>("#copy-terminal"));
fit.fit();
new ResizeObserver(() => fit.fit()).observe(termEl);
// iOS only raises the keyboard when focus happens inside the tap's own event handler.
termEl.addEventListener("touchend", () => term.focus(), { passive: true });
termEl.addEventListener("click", () => term.focus());

function openLink(uri: string): void {
  window.open(uri, "_blank", "noopener");
}

linkLocalUrls(term, previews);

const shell = new Shell(term, {
  fs,
  runBun,
  kill,
  changed: () => editor.syncFromFs(),
  open: (path) => editor.open(path),
  info: () => [
    `bun.wasm: ${wasm && "module" in wasm ? `${wasmUrl}, ${mb(wasm.size)}` : (wasm?.error ?? "loading")}`,
    `sleeps: ${sleepMode}`,
    `engine: ${engineName}`,
    `network: ${networkInfo()}`,
    fs.vfs.persistent
      ? `filesystem: persistent browser storage, preopened at /, cwd ${HOME}; editor saves survive reload`
      : `filesystem: memory-only browser storage, preopened at /, cwd ${HOME}; editor saves do not survive reload`,
  ],
});

function networkInfo(): string {
  if (!isolated && engine === "browser") return "the browser's own fetch (CORS applies); no Bun.serve previews (needs cross-origin isolation)";
  if (!isolated) return "off (needs cross-origin isolation)";
  return params.has("root-previews") ? "fetch via the page; Bun.serve previews at their own origins" : "fetch via the page; Bun.serve previews at ./__preview/<port>/";
}

// ---------- editor ----------

class Editor {
  private states = new Map<string, EditorState>();
  private saved = new Map<string, string>();
  private view: EditorView;
  private opened = false;
  private openRevision = 0;
  private tabsRevision = 0;
  path = `${HOME}/index.ts`;

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent, state: EditorState.create({ extensions: this.extensions(this.path) }) });
  }

  private extensions(path: string): Extension[] {
    const ts = /\.(m|c)?tsx?$/.test(path);
    const jsx = /x$/.test(path);
    return [
      basicSetup,
      javascript({ typescript: ts, jsx }),
      oneDark,
      EditorView.lineWrapping,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (void this.save().catch(reportError), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (void runCurrent().catch(reportError), true) },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) void this.renderTabs().catch(reportError);
      }),
    ];
  }

  private async stateFor(path: string): Promise<EditorState> {
    let state = this.states.get(path);
    if (!state) {
      const text = decode(await fs.readFile(path) ?? new Uint8Array());
      // Another open may have populated (and edited) this file while the read was pending.
      state = this.states.get(path);
      if (state) return state;
      state = EditorState.create({ doc: text, extensions: this.extensions(path) });
      this.states.set(path, state);
      this.saved.set(path, text);
    }
    return state;
  }

  private dirty(path: string): boolean {
    const state = path === this.path ? this.view.state : this.states.get(path);
    return state !== undefined && state.doc.toString() !== this.saved.get(path);
  }

  async open(path: string): Promise<void> {
    const revision = ++this.openRevision;
    if (path !== this.path || !this.opened) {
      await this.stateFor(path);
      if (revision !== this.openRevision) return;
      // Keep path and view paired until the requested state is ready. Typing and saves
      // during the read still belong to the file currently on screen.
      if (this.opened && this.states.has(this.path)) this.states.set(this.path, this.view.state);
      this.path = path;
      this.view.setState(this.states.get(path)!);
      this.opened = true;
    }
    await this.renderTabs();
  }

  async save(): Promise<void> {
    const path = this.path;
    const text = this.view.state.doc.toString();
    await fs.writeFile(path, text);
    await fs.flush(path);
    this.saved.set(path, text);
    await this.renderTabs();
  }

  /** Pick up files created, changed or deleted by bun.wasm or the shell. Unsaved edits win. */
  async syncFromFs(): Promise<void> {
    this.states.set(this.path, this.view.state);
    for (const path of Array.from(this.states.keys())) {
      const data = await fs.readFile(path);
      if (!data) {
        if (!this.dirty(path)) {
          this.states.delete(path);
          this.saved.delete(path);
        }
        continue;
      }
      const text = decode(data);
      if (text === this.saved.get(path) || this.dirty(path)) continue;
      const state = path === this.path ? this.view.state : this.states.get(path);
      if (!state) continue;
      this.saved.set(path, text);
      const next = state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state;
      this.states.set(path, next);
      if (path === this.path) this.view.setState(next);
    }
    const path = this.path;
    const revision = this.openRevision;
    if (!await fs.readFile(path) && !this.states.has(path)) {
      const first = (await fs.listFiles(HOME))[0];
      if (first && revision === this.openRevision) await this.open(first);
    }
    await this.renderTabs();
  }

  async renderTabs(): Promise<void> {
    const revision = ++this.tabsRevision;
    const files = await fs.listFiles(HOME);
    if (revision !== this.tabsRevision) return;
    for (const path of this.states.keys()) if (!files.includes(path)) files.push(path);
    tabsEl.replaceChildren(
      ...files.map((path) => {
        const tab = document.createElement("button");
        tab.className = "tab";
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(path === this.path));
        tab.textContent = path.slice(HOME.length + 1) + (this.dirty(path) ? " •" : "");
        tab.title = path;
        tab.onclick = () => void this.open(path).catch(reportError);
        return tab;
      }),
    );
    tabsEl.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    fileSelect.replaceChildren(
      ...files.map((path) => {
        const option = document.createElement("option");
        option.value = path;
        option.textContent = path.slice(HOME.length + 1) + (this.dirty(path) ? " •" : "");
        return option;
      }),
    );
    fileSelect.value = this.path;
    fileSelect.onchange = () => void this.open(fileSelect.value).catch(reportError);
  }

  focus(): void {
    this.view.focus();
  }
}

const editor = new Editor($<HTMLDivElement>("#editor"));
await editor.open(editor.path);
await editor.renderTabs();

function reportError(error: unknown): void {
  setStatus(String(error), "error");
  term.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
}

let runPending = false;
async function runCurrent(): Promise<void> {
  if (shell.running || runPending) return;
  runPending = true;
  runButton.disabled = true;
  try {
    const path = editor.path;
    await editor.save();
    const rel = path.startsWith(`${shell.cwd}/`) ? path.slice(shell.cwd.length + 1) : path;
    const quoted = `'${rel.replace(/'/g, "'\\''")}'`;
    // Test files run under Bun's test runner, like `bun test <file>` would.
    const command = /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ? "test" : "run";
    await shell.submit(`bun ${command} ${quoted}`);
  } finally {
    runPending = false;
    runButton.disabled = shell.running;
  }
}

newFileButton.addEventListener("click", () => {
  const name = prompt("New file name (in ~):", "scratch.ts");
  if (!name) return;
  const path = normalize(name, HOME);
  void (async () => {
    if (!await fs.lookup(path)) await fs.writeFile(path, "");
    await editor.open(path);
    editor.focus();
  })().catch(reportError);
});

// Keep the app inside the visible area when the iOS keyboard opens.
const vv = window.visualViewport;
if (vv) {
  const onViewport = () => {
    document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
    if (vv.offsetTop > 0) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", onViewport);
  vv.addEventListener("scroll", onViewport);
  onViewport();
}

shell.start([
  "\x1b[1mBun in your browser\x1b[0m: bun.wasm (wasm32-wasip1) in a Web Worker.",
  `Type \x1b[32mhelp\x1b[0m, try \x1b[32mbun run index.ts\x1b[0m, or press Run.`,
  "",
]);

Object.assign(globalThis, { playground: { fs, shell, term, editor, previews } });
if (!fs.ownershipLost) {
  startup = "ready";
  runButton.disabled = false;
  newFileButton.disabled = false;
  engineSelect.disabled = false;
  fileSelect.disabled = false;
}
pageSetUp();
if (startup === "ready") whenIdle(warmFirstCommand);

// The first command would otherwise load the runner, Waffle's process and network services and
// then the worker's chunks one after another, each a network round trip. Put them in the HTTP
// cache while the page is idle. Only fetch: importing or initializing here could leave a failure
// behind (a rejected module or service) that a later command would inherit. A failed fetch leaves
// nothing, and the command loads the file itself.
function warmFirstCommand(): void {
  for (const chunk of commandChunks()) void fetch(chunk, { priority: "low" }).then(response => response.arrayBuffer()).catch(() => {});
}
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}

void main().catch(error => showPageStartupFailure(error, {
  button: "#run", disable: "#new-file, #engine, #file-select", title: "Retry playground startup",
}));
