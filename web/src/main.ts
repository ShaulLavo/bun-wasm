import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { javascript } from "@codemirror/lang-javascript";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { basicSetup } from "codemirror";
import { HOME, examples } from "./examples";
import { MemFS, adoptInodes, decode, normalize } from "./fs";
import { Previews } from "./preview";
import { ENGINES as engines, type Engine, WasmMissing, isEngine, loadWasm as fetchWasm, mb, registerModuleScope, type Run, startRun } from "./runner";
import { type Output, Shell } from "./shell";
import { enableTerminalCopy } from "./terminal-copy";

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
const previews = new Previews();

// ---------- filesystem ----------

const fs = new MemFS();
fs.mkdirp("/tmp");
for (const [name, source] of Object.entries(examples)) fs.writeFile(`${HOME}/${name}`, source);

// ---------- bun.wasm ----------

let wasm: { module: WebAssembly.Module; size: number } | { error: string } | null = null;
const wasmReady = loadWasm();

function setStatus(text: string, kind: "" | "ok" | "error" = ""): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

async function loadWasm(): Promise<void> {
  try {
    const loaded = await fetchWasm(wasmUrl, (text) => setStatus(text));
    wasm = loaded;
    setStatus(`bun.wasm ready · ${engineName} · ${mb(loaded.size)}`, "ok");
  } catch (err) {
    const missing = err instanceof WasmMissing;
    const error = missing
      ? `${wasmUrl} is not in this build. Build it with ${engines[engine].script} (dist/${engines[engine].wasm}), then rebuild web/.`
      : `could not load bun.wasm: ${String(err)}`;
    wasm = { error };
    setStatus(missing ? "bun.wasm missing" : "bun.wasm failed to load", "error");
  }
}

// The browser engine's modules are served under ./__bunwasm/ (runner.ts), so imports can form cycles.
const moduleScope: Promise<boolean> = engine === "browser" ? registerModuleScope() : Promise.resolve(false);

let current: Run | null = null;
const savedDuringRun = new Map<string, string>();

async function runBun(args: string[], cwd: string, io: Output): Promise<number> {
  await wasmReady;
  if (!wasm || "error" in wasm) {
    io.err(`\x1b[31m${wasm?.error ?? "bun.wasm unavailable"}\x1b[0m\r\n`);
    return 127;
  }
  const env: Record<string, string> = {
    HOME,
    PWD: cwd,
    USER: "user",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(term.cols),
    LINES: String(term.rows),
    TMPDIR: "/tmp",
  };
  const scoped = await moduleScope;
  runButton.disabled = true;
  const run = startRun({ engine, module: wasm.module, args, env, root: fs.root, moduleScope: scoped, trace }, {
    stdout: (data) => io.out(data),
    stderr: (data) => io.err(data),
    listening: (port, helper) => {
      previews.register(port, helper);
      void previews.ready.then((state) => io.out(previewLine(port, state)));
    },
    stopped: (port, helper) => previews.unregister(port, helper),
  });
  current = run;
  const result = await run.done;
  current = null;
  runButton.disabled = false;
  if (result.root) {
    fs.root = result.root;
    adoptInodes(fs.root);
  }
  if (result.error) io.err(`\x1b[31m${result.error}\x1b[0m\r\n`);
  for (const [path, text] of savedDuringRun) fs.writeFile(path, text);
  savedDuringRun.clear();
  editor.syncFromFs();
  return result.code;
}

function previewLine(port: number, state: string): string {
  if (state !== "ready") return `\x1b[2m[preview] port ${port}: previews need a service worker (${state} here)\x1b[0m\r\n`;
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

// `http://localhost:<port>/…` printed by a guest server (server.url) opens that server's preview.
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(\/[^\s'"`)]*)?/g;
term.registerLinkProvider({
  provideLinks(y, callback) {
    const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
    const links = Array.from(text.matchAll(LOCAL_URL))
      .filter((m) => previews.serves(Number(m[1])))
      .map((m) => ({
        text: m[0],
        range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
        activate: () => openLink(previews.url(Number(m[1]), m[2] ?? "/")),
      }));
    callback(links.length > 0 ? links : undefined);
  },
});

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
    `filesystem: in memory, preopened at /, cwd ${HOME}; reloading the page resets it`,
  ],
});

function networkInfo(): string {
  if (!isolated && engine === "browser") return "the browser's own fetch (CORS applies); no Bun.serve previews (needs cross-origin isolation)";
  return isolated ? "fetch via the page; Bun.serve previews at ./__preview/<port>/" : "off (needs cross-origin isolation)";
}

// ---------- editor ----------

class Editor {
  private states = new Map<string, EditorState>();
  private saved = new Map<string, string>();
  private view: EditorView;
  path = `${HOME}/index.ts`;

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent, state: this.stateFor(this.path) });
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
        { key: "Mod-s", preventDefault: true, run: () => (this.save(), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (void runCurrent(), true) },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.renderTabs();
      }),
    ];
  }

  private stateFor(path: string): EditorState {
    let state = this.states.get(path);
    if (!state) {
      const text = decode(fs.readFile(path) ?? new Uint8Array());
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

  open(path: string): void {
    if (path !== this.path) {
      this.states.set(this.path, this.view.state);
      this.path = path;
      this.view.setState(this.stateFor(path));
    }
    this.renderTabs();
  }

  save(): void {
    const text = this.view.state.doc.toString();
    fs.writeFile(this.path, text);
    if (current) savedDuringRun.set(this.path, text);
    this.saved.set(this.path, text);
    this.renderTabs();
  }

  /** Pick up files created, changed or deleted by bun.wasm or the shell. Unsaved edits win. */
  syncFromFs(): void {
    this.states.set(this.path, this.view.state);
    for (const [path, state] of this.states) {
      const data = fs.readFile(path);
      if (!data) {
        if (!this.dirty(path)) {
          this.states.delete(path);
          this.saved.delete(path);
        }
        continue;
      }
      const text = decode(data);
      if (text === this.saved.get(path) || this.dirty(path)) continue;
      this.saved.set(path, text);
      const next = state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state;
      this.states.set(path, next);
      if (path === this.path) this.view.setState(next);
    }
    if (!fs.readFile(this.path) && !this.states.has(this.path)) {
      const first = fs.listFiles(HOME)[0];
      if (first) {
        this.path = first;
        this.view.setState(this.stateFor(first));
      }
    }
    this.renderTabs();
  }

  renderTabs(): void {
    const files = fs.listFiles(HOME);
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
        tab.onclick = () => this.open(path);
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
    fileSelect.onchange = () => this.open(fileSelect.value);
  }

  focus(): void {
    this.view.focus();
  }
}

const editor = new Editor($<HTMLDivElement>("#editor"));
editor.renderTabs();

async function runCurrent(): Promise<void> {
  if (shell.running) return;
  editor.save();
  const rel = editor.path.startsWith(`${shell.cwd}/`) ? editor.path.slice(shell.cwd.length + 1) : editor.path;
  const quoted = /\s/.test(rel) ? `'${rel}'` : rel;
  // Test files run under Bun's test runner, like `bun test <file>` would.
  const command = /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ? "test" : "run";
  await shell.submit(`bun ${command} ${quoted}`);
}

runButton.addEventListener("click", () => void runCurrent());
newFileButton.addEventListener("click", () => {
  const name = prompt("New file name (in ~):", "scratch.ts");
  if (!name) return;
  const path = normalize(name, HOME);
  if (!fs.lookup(path)) fs.writeFile(path, "");
  editor.open(path);
  editor.focus();
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

Object.assign(globalThis, { playground: { fs, shell, term, editor } });
