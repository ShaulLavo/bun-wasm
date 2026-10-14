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
import { type Output, Shell } from "./shell";
import type { RunRequest, WorkerMessage } from "./worker";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $<HTMLSpanElement>("#status");
const runButton = $<HTMLButtonElement>("#run");
const tabsEl = $<HTMLDivElement>("#tabs");
const newFileButton = $<HTMLButtonElement>("#new-file");

const params = new URLSearchParams(location.search);
const wasmUrl = params.get("wasm") ?? "bun.wasm";
const trace = params.has("trace");
const isolated = globalThis.crossOriginIsolated === true;
const sleepMode = isolated ? "Atomics.wait (cross-origin isolated)" : "busy-wait (page is not cross-origin isolated)";

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
    setStatus("loading bun.wasm…");
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`${wasmUrl}: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      setStatus(`loading bun.wasm… ${mb(received)}${total ? ` / ${mb(total)}` : ""}`);
    }
    const bytes = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    setStatus(`compiling bun.wasm (${mb(received)})…`);
    const module = await WebAssembly.compile(bytes);
    wasm = { module, size: received };
    setStatus(`bun.wasm ready · ${mb(received)}`, "ok");
  } catch (err) {
    const missing = String(err).includes("HTTP 404");
    const error = missing
      ? `bun.wasm is not in this build. Build it with scripts/build.sh (dist/bun.wasm), then rebuild web/.`
      : `could not load bun.wasm: ${String(err)}`;
    wasm = { error };
    setStatus(missing ? "bun.wasm missing" : "bun.wasm failed to load", "error");
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let current: { worker: Worker; finish(code: number): void } | null = null;
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
  const request: RunRequest = { module: wasm.module, args: ["bun", ...args], env, root: fs.root, trace };
  const worker = new Worker("./worker.js", { type: "module" });
  runButton.disabled = true;
  return new Promise<number>((resolve) => {
    const finish = (code: number) => {
      worker.terminate();
      current = null;
      runButton.disabled = false;
      for (const [path, text] of savedDuringRun) fs.writeFile(path, text);
      savedDuringRun.clear();
      editor.syncFromFs();
      resolve(code);
    };
    current = { worker, finish };
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "stdout" || msg.type === "stderr") {
        (msg.type === "stdout" ? io.out : io.err)(msg.data);
        return;
      }
      fs.root = msg.root;
      adoptInodes(fs.root);
      if (msg.type === "error") io.err(`\x1b[31mbun.wasm crashed: ${msg.message}\x1b[0m\r\n`);
      finish(msg.type === "exit" ? msg.code : 134);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      io.err(`\x1b[31mworker error: ${event.message}\x1b[0m\r\n`);
      finish(1);
    };
    worker.postMessage(request);
  });
}

function kill(): void {
  if (!current) return;
  term.write("^C\r\n");
  current.finish(130);
}

// ---------- terminal ----------

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  fontSize: window.matchMedia("(max-width: 800px)").matches ? 13 : 14,
  scrollback: 5000,
  theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#fbf0df", selectionBackground: "#3a3d4a" },
});
const fit = new FitAddon();
term.loadAddon(fit);
const termEl = $<HTMLDivElement>("#terminal");
term.open(termEl);
fit.fit();
new ResizeObserver(() => fit.fit()).observe(termEl);
// iOS only raises the keyboard when focus happens inside the tap's own event handler.
termEl.addEventListener("touchend", () => term.focus(), { passive: true });
termEl.addEventListener("click", () => term.focus());

const shell = new Shell(term, {
  fs,
  runBun,
  kill,
  changed: () => editor.syncFromFs(),
  open: (path) => editor.open(path),
  info: () => [
    `bun.wasm: ${wasm && "module" in wasm ? `${wasmUrl}, ${mb(wasm.size)}` : (wasm?.error ?? "loading")}`,
    `sleeps: ${sleepMode}`,
    `filesystem: in memory, preopened at /, cwd ${HOME}; reloading the page resets it`,
  ],
});

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
