import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { basicSetup } from "codemirror";
import { MemFS, decode } from "../../web/src/fs";
import type { NetHelper } from "../../web/src/net/helper";
import { Previews } from "../../web/src/preview";
import { ENGINES, type Engine, type Run, WasmMissing, isEngine, loadWasm, mb, registerModuleScope, startRun } from "../../web/src/runner";
import { enableTerminalCopy } from "../../web/src/terminal-copy";
import { linkLocalUrls } from "../../web/src/terminal-links";
import { measureStartup } from "../../web/src/startup";
import { depsCacheKey, readDeps, writeDeps } from "./deps-cache";
import { StartupOutput } from "./startup-output";

const HOME = "/home/user";
/** The project's directory in the guest's filesystem. */
const APP = `${HOME}/app`;
const PORT = 5173;
/** Files the user changed, kept across reloads and engine switches. */
const template = new URLSearchParams(location.search).get("template") === "vanilla" ? "vanilla" : "react";
const templateFile = template === "vanilla" ? "template-vanilla.json" : "template.json";
const EDITS_KEY = `bun-wasm-sandbox:edits:${template}`;
const SAVE_DELAY_MS = 350;
/** Opened first. */
const START_FILE = template === "vanilla" ? "src/main.ts" : "src/App.tsx";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $<HTMLSpanElement>("#status");
const engineSelect = $<HTMLSelectElement>("#engine");
const templateSelect = $<HTMLSelectElement>("#template");
templateSelect.value = template;
templateSelect.addEventListener("change", () => {
  const next = new URL(location.href);
  if (templateSelect.value === "react") next.searchParams.delete("template");
  else next.searchParams.set("template", templateSelect.value);
  location.assign(next);
});
const restartButton = $<HTMLButtonElement>("#restart");
const treeEl = $<HTMLUListElement>("#tree");
const fileSelect = $<HTMLSelectElement>("#file-select");
const fileName = $<HTMLSpanElement>("#file-name");
const saveState = $<HTMLSpanElement>("#save-state");
const previewFrame = $<HTMLIFrameElement>("#preview");
const previewUrl = $<HTMLAnchorElement>("#preview-url");
const openPreview = $<HTMLAnchorElement>("#open-preview");
const serverDot = $<HTMLSpanElement>("#server-dot");

const params = new URLSearchParams(location.search);
const DEFAULT_ENGINE: Engine = "browser";
const requested = params.get("engine");
const engine: Engine = isEngine(requested) ? requested : DEFAULT_ENGINE;
const wasmUrl = params.get("wasm") ?? ENGINES[engine].wasm;

engineSelect.value = engine;
engineSelect.addEventListener("change", () => {
  // The edits are already in sessionStorage; the reloaded page restores them.
  const next = new URL(location.href);
  if (engineSelect.value === DEFAULT_ENGINE) next.searchParams.delete("engine");
  else next.searchParams.set("engine", engineSelect.value);
  next.searchParams.delete("wasm");
  location.assign(next);
});

function setStatus(text: string, kind: "" | "ok" | "error" = ""): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function setSaveState(text: string, kind: "" | "ok" | "error" = ""): void {
  saveState.textContent = text;
  saveState.dataset.kind = kind;
}

// ---------- filesystem ----------

const fs = new MemFS();
fs.mkdirp("/tmp");
const rel = (path: string) => path.slice(APP.length + 1);
const abs = (relPath: string) => `${APP}/${relPath}`;

function loadEdits(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(EDITS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

const edits = loadEdits();

function rememberEdit(relPath: string, text: string): void {
  edits[relPath] = text;
  try {
    sessionStorage.setItem(EDITS_KEY, JSON.stringify(edits));
  } catch {
    /* storage full or disabled: edits last until the page reloads */
  }
}

function templateFiles(text: string): Record<string, string> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("files" in value)) return null;
    const files = value.files;
    if (!files || typeof files !== "object") return null;
    const output: Record<string, string> = {};
    for (const [path, source] of Object.entries(files)) {
      if (typeof source !== "string") return null;
      output[path] = source;
    }
    return typeof output["index.html"] === "string" ? output : null;
  } catch { return null; }
}

async function loadTemplate(): Promise<void> {
  const started = performance.now();
  const response = await fetch(`./${templateFile}`);
  if (!response.ok) throw new Error(`${templateFile}: HTTP ${response.status}`);
  const files = templateFiles(await response.text());
  if (!files) throw new Error(`${templateFile}: invalid project files`);
  measureStartup("template", started);
  for (const [path, text] of Object.entries(files)) fs.writeFile(abs(path), text);
  for (const [path, text] of Object.entries(edits)) fs.writeFile(abs(path), text);
}

// ---------- terminal ----------

const term = new Terminal({
  convertEol: true,
  disableStdin: true,
  cursorBlink: false,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  fontSize: window.matchMedia("(max-width: 800px)").matches ? 11 : 13,
  scrollback: 5000,
  theme: { background: "#14151a", foreground: "#e6e6e6", cursor: "#14151a", selectionBackground: "#3a3d4a" },
});
const fit = new FitAddon();
term.loadAddon(fit);
const termEl = $<HTMLDivElement>("#terminal");
term.open(termEl);
enableTerminalCopy(term, $<HTMLButtonElement>("#copy-terminal"));
fit.fit();
new ResizeObserver(() => fit.fit()).observe(termEl);

// ---------- dev server ----------

const previews = new Previews();
linkLocalUrls(term, previews);
const moduleScope: Promise<boolean> = engine === "browser" ? registerModuleScope() : Promise.resolve(false);
let wasm: Awaited<ReturnType<typeof loadWasm>> | null = null;
let firstStart = true;
let depsKey: string | null = null;
const DEPS_PATH = "/.bunwasm/deps-cache";

interface Server {
  port: number;
  helper: NetHelper;
}

let run: Run | null = null;
let server: Server | null = null;
/** Saved while the dev server was starting (after its filesystem snapshot): sent once it listens. */
const unsent = new Map<string, string>();

function setServerState(state: "starting" | "up" | "down", text: string): void {
  serverDot.dataset.state = state;
  previewUrl.textContent = text;
  if (state !== "up") previewUrl.removeAttribute("href");
  openPreview.setAttribute("aria-disabled", String(state !== "up"));
}

async function startDevServer(): Promise<void> {
  stopDevServer();
  if (!wasm) return;
  const visibleStart = firstStart ? 0 : performance.now();
  firstStart = false;
  setStatus("waiting for module service worker…");
  const scoped = await moduleScope;
  unsent.clear();
  for (const phase of ["deps-cached", "bundling-react", "bundled-react"]) {
    performance.clearMarks(`bunwasm:${phase}`);
    performance.clearMeasures(`bunwasm:${phase}`);
  }
  const changedDeps = Object.keys(edits).some((path) => path === "package.json" || path.startsWith("node_modules/"));
  depsKey = changedDeps ? null : depsCacheKey(engine, wasm.build, templateFile);
  const cached = depsKey ? await readDeps(depsKey) : null;
  fs.remove(DEPS_PATH);
  if (cached) fs.writeFile(DEPS_PATH, cached);
  setStatus("starting worker…");
  setServerState("starting", "starting dev server…");
  term.write(`\x1b[2m$\x1b[0m bun ./index.html \x1b[2m(${ENGINES[engine].name})\x1b[0m\r\n`);
  const env: Record<string, string> = {
    HOME,
    PWD: APP,
    USER: "user",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(term.cols),
    LINES: String(term.rows),
    TMPDIR: "/tmp",
    PORT: String(PORT),
    BUN_WASM_STARTUP: "1",
  };
  const started = performance.now();
  const output = new StartupOutput((text) => term.write(text), startupRecord);
  const current = startRun({ engine, module: wasm.module, args: ["./index.html"], env, root: fs.root, moduleScope: scoped }, {
    phase: (name) => {
      if (name === "worker-start") setStatus("starting dev server…");
    },
    stdout: (data) => output.write(data),
    stderr: (data) => output.write(data),
    listening: (port, helper) => {
      previews.register(port, helper);
      if (run !== current) return;
      server = { port, helper };
      measureStartup("dev-server", started);
      void showPreview(port, visibleStart);
      for (const [path, text] of unsent) void sendUpdate(path, text);
      unsent.clear();
    },
    stopped: (port, helper) => {
      previews.unregister(port, helper);
      if (server?.helper === helper) server = null;
    },
  });
  run = current;
  const result = await current.done;
  output.flush();
  if (result.error) term.write(`\x1b[31m${result.error}\x1b[0m\r\n`);
  if (run !== current) return; // restarted
  run = null;
  server = null;
  term.write(`\x1b[2m[dev server exited with code ${result.code}]\x1b[0m\r\n`);
  setServerState("down", `dev server stopped (exit ${result.code}) · press Restart`);
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

async function saveDeps(target: Server, key: string): Promise<void> {
  try {
    const result = await guestBytes(target, "/_bun/deps-cache");
    if (result.status !== 200 || server !== target || decode(result.bytes.subarray(0, 8)) !== "BUNDEPS1") return;
    fs.writeFile(DEPS_PATH, result.bytes);
    await writeDeps(key, result.bytes);
  } catch {
    // Restart can close the guest while the dependency cache is being saved.
  }
}

function stopDevServer(): void {
  const current = run;
  run = null;
  server = null;
  current?.kill();
}

async function showPreview(port: number, visibleStart: number): Promise<void> {
  const state = await previews.ready;
  if (state !== "ready") {
    setServerState("down", `previews need a service worker (${state} here)`);
    return;
  }
  const url = previews.url(port, "/");
  setServerState("up", `localhost:${port}/`);
  openPreview.href = url;
  // The label shows the server's own address; tapping it opens the preview, which works anywhere.
  previewUrl.href = url;
  setStatus("loading preview…");
  const previewStarted = performance.now();
  previewFrame.addEventListener("load", () => {
    measureStartup("preview", previewStarted);
    if (server && depsKey) void saveDeps(server, depsKey);
    setStatus(`dev server ready in ${((performance.now() - visibleStart) / 1000).toFixed(1)} s · ${ENGINES[engine].name} · ${mb(wasm?.size ?? 0)}`, "ok");
  }, { once: true });
  previewFrame.src = url;
}

async function sendUpdate(path: string, text: string): Promise<void> {
  const target = server;
  if (!target) return;
  try {
    await target.helper.changeFile(abs(path), text);
    if (server === target) setSaveState("saved", "ok");
  } catch (error) {
    setSaveState(`not sent: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function save(path: string, text: string): void {
  fs.writeFile(abs(path), text);
  rememberEdit(path, text);
  if (server) void sendUpdate(path, text);
  else if (run) unsent.set(path, text);
  else setSaveState("saved", "ok");
}

// ---------- editor ----------

function language(path: string): Extension {
  if (/\.css$/.test(path)) return css();
  if (/\.html?$/.test(path)) return html();
  return javascript({ typescript: /\.(m|c)?tsx?$/.test(path), jsx: /x$/.test(path) });
}

class Editor {
  private states = new Map<string, EditorState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private view: EditorView;
  path = "";

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent });
  }

  private extensions(path: string): Extension[] {
    const readOnly = path.startsWith("node_modules/");
    return [
      basicSetup,
      language(path),
      oneDark,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (this.flush(path), true) }]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !readOnly) this.schedule(path);
      }),
    ];
  }

  private stateFor(path: string): EditorState {
    let state = this.states.get(path);
    if (!state) {
      const text = decode(fs.readFile(abs(path)) ?? new Uint8Array());
      state = EditorState.create({ doc: text, extensions: this.extensions(path) });
      this.states.set(path, state);
    }
    return state;
  }

  private text(path: string): string {
    return (path === this.path ? this.view.state : this.states.get(path))?.doc.toString() ?? "";
  }

  /** Debounced save: typing a word is one update, not one per key. */
  private schedule(path: string): void {
    clearTimeout(this.timers.get(path));
    setSaveState("editing…");
    this.timers.set(
      path,
      setTimeout(() => this.flush(path), SAVE_DELAY_MS),
    );
  }

  flush(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    save(path, this.text(path));
  }

  open(path: string): void {
    if (path === this.path) return;
    if (this.path) this.states.set(this.path, this.view.state);
    this.path = path;
    this.view.setState(this.stateFor(path));
    fileName.textContent = path;
    fileSelect.value = path;
    tree.select(path);
  }

  /** Replaces a file's text (tests use this to type like a person would). */
  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }
}

// ---------- file tree ----------

interface Folder {
  folders: Map<string, Folder>;
  files: string[];
}

class Tree {
  /** Folders that are closed; node_modules starts closed. */
  private closed = new Set<string>(["node_modules"]);
  private current = "";

  render(): void {
    const root: Folder = { folders: new Map(), files: [] };
    const paths = fs.listFiles(APP).map(rel).filter((p) => !p.split("/").some((part) => part.startsWith(".")));
    for (const path of paths) {
      const parts = path.split("/");
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        let next = folder.folders.get(part);
        if (!next) folder.folders.set(part, (next = { folders: new Map(), files: [] }));
        folder = next;
      }
      folder.files.push(path);
    }
    treeEl.replaceChildren(...this.items(root, "", 0));
    fileSelect.replaceChildren(
      ...paths
        .filter((p) => !p.startsWith("node_modules/"))
        .map((p) => Object.assign(document.createElement("option"), { value: p, textContent: p })),
    );
    fileSelect.value = this.current;
  }

  private items(folder: Folder, prefix: string, depth: number): HTMLLIElement[] {
    const out: HTMLLIElement[] = [];
    for (const [name, child] of Array.from(folder.folders).sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name;
      const open = !this.closed.has(path);
      const li = document.createElement("li");
      li.setAttribute("role", "treeitem");
      li.setAttribute("aria-expanded", String(open));
      const button = this.button(`${name}`, depth, open ? "▾" : "▸", "folder");
      button.onclick = () => {
        if (open) this.closed.add(path);
        else this.closed.delete(path);
        this.render();
      };
      li.append(button);
      if (open) {
        const ul = document.createElement("ul");
        ul.setAttribute("role", "group");
        ul.append(...this.items(child, `${path}/`, depth + 1));
        li.append(ul);
      }
      out.push(li);
    }
    for (const path of folder.files.sort()) {
      const li = document.createElement("li");
      li.setAttribute("role", "treeitem");
      const button = this.button(path.slice(prefix.length), depth, "", "file");
      button.dataset.path = path;
      if (path === this.current) button.setAttribute("aria-current", "true");
      button.onclick = () => editor.open(path);
      li.append(button);
      out.push(li);
    }
    return out;
  }

  private button(label: string, depth: number, icon: string, kind: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind;
    button.style.setProperty("--depth", String(depth));
    const iconEl = Object.assign(document.createElement("span"), { className: "icon", textContent: icon });
    button.append(iconEl, document.createTextNode(label));
    return button;
  }

  select(path: string): void {
    this.current = path;
    for (const el of treeEl.querySelectorAll<HTMLButtonElement>("button.file")) {
      if (el.dataset.path === path) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    }
  }
}

const tree = new Tree();
const editor = new Editor($<HTMLDivElement>("#editor"));
fileSelect.addEventListener("change", () => editor.open(fileSelect.value));

restartButton.addEventListener("click", () => {
  term.write("\r\n");
  void startDevServer();
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

// ---------- start ----------

async function boot(): Promise<void> {
  setServerState("starting", "loading…");
  if (!globalThis.crossOriginIsolated) {
    setStatus("this page is not cross-origin isolated: the dev server can't serve previews", "error");
  }
  const template = loadTemplate();
  try {
    wasm = await loadWasm(wasmUrl, (text) => setStatus(text));
  } catch (err) {
    const missing = err instanceof WasmMissing;
    setStatus(missing ? `${ENGINES[engine].wasm} is not in this build` : `could not load bun.wasm: ${String(err)}`, "error");
    setServerState("down", "no engine");
  }
  await template;
  tree.render();
  editor.open(fs.lookup(abs(START_FILE)) ? START_FILE : (fs.listFiles(APP).map(rel)[0] ?? START_FILE));
  if (wasm) {
    setStatus(`starting the dev server on ${ENGINES[engine].name}…`);
    await startDevServer();
  }
}

void boot();

Object.assign(globalThis, { sandbox: { fs, editor, term, restart: startDevServer, server: () => server, engine, template } });
