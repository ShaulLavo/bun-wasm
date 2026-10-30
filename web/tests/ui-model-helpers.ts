import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import * as stateModule from "@codemirror/state";
import * as viewModule from "@codemirror/view";
import type { Runtime } from "waffle";
import { getVfsDescriptor } from "../src/shared-fs";
import * as engineLoader from "../src/engine-loader";
import type { Playground } from "../src/playground/playground";
import type { Sandbox } from "../../sandbox/src/sandbox";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class View {
  state: EditorState;
  constructor(options: { state?: EditorState } = {}) { this.state = options.state ?? EditorState.create(); }
  setState(state: EditorState) { this.state = state; }
  dispatch(spec: Parameters<EditorState["update"]>[0]) {
    const transaction = this.state.update(spec);
    this.state = transaction.state;
    for (const listener of this.state.facet(viewModule.EditorView.updateListener)) listener({ docChanged: transaction.docChanged } as Parameters<typeof listener>[0]);
  }
  focus() {}
}
Object.setPrototypeOf(View, viewModule.EditorView);

function unsupported(): never { throw new Error("Unexpected filesystem boundary call"); }

export function filesystemFixture() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const reads = new Map<string, ReturnType<typeof deferred<Uint8Array | undefined>>>();
  const writes: { path: string; text: string; done: ReturnType<typeof deferred<void>> }[] = [];
  const checkpoints: ReturnType<typeof deferred<void>>[] = [];
  const control = { holdWrites: false, checkpoints: 0, beforeWrite: undefined as ((path: string) => void) | undefined };
  const fs: Runtime["filesystem"] = {
    vfs: getVfsDescriptor("memory"), ownershipLost: false, workspace: undefined,
    state: { status: "ready" as const },
    directoryHandle: unsupported, createIdentity: unsupported, fork: unsupported, connect: unsupported,
    revoke: unsupported, reap: unsupported, quiesce: unsupported, drain: unsupported, resolvePath: unsupported, move: unsupported,
    onOwnershipLost: undefined as (() => void) | undefined,
    onStateChange: undefined as Runtime["filesystem"]["onStateChange"],
    async mkdirp(path: string) {
      const parts = path.split("/").filter(Boolean);
      for (let length = 1; length <= parts.length; length++) directories.add(`/${parts.slice(0, length).join("/")}`);
    },
    async lookup(path: string): ReturnType<Runtime["filesystem"]["lookup"]> { return directories.has(path) ? { kind: "dir", ino: 0, mtime: 0, children: new Map() } : files.has(path) ? { kind: "file", ino: 0, mtime: 0 } : undefined; },
    async readFile(path: string) { return reads.get(path)?.promise ?? (files.has(path) ? new TextEncoder().encode(files.get(path)) : undefined); },
    async listFiles(root = "/") { return Array.from(files.keys()).filter(path => path.startsWith(root)); },
    async writeFile(path: string, contents: string | Uint8Array) {
      const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
      control.beforeWrite?.(path);
      if (control.holdWrites) {
        const done = deferred<void>();
        writes.push({ path, text, done });
        await done.promise;
      }
      await fs.mkdirp(path.slice(0, path.lastIndexOf("/")));
      files.set(path, text);
    },
    async remove(path: string) {
      const existed = files.has(path) || directories.has(path);
      for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
      return existed;
    },
    async flush() { control.checkpoints++; await checkpoints.shift()?.promise; },
  };
  return { fs, files, directories, reads, writes, checkpoints, control };
}

type FilesystemFixture = ReturnType<typeof filesystemFixture>;
export function filesystem(fixture: FilesystemFixture): Runtime["filesystem"] { return fixture.fs; }

class TerminalFixture {
  cols = 80;
  rows = 24;
  loadAddon() {}
  open() {}
  write() {}
  writeln() {}
  onData() {}
  onResize() {}
  registerLinkProvider() { return { dispose() {} }; }
}

let identity = 0;
export async function models(fixture = filesystemFixture(), sources: Record<string, string> = { "index.ts": "example", "deleted.ts": "delete me" }) {
  const listeners: ((event: { persisted: boolean }) => void)[] = [];
  const loads: string[] = [];
  const runs: { args: string[]; done: ReturnType<typeof deferred<{ code: number }>>; kills: number[] }[] = [];
  let runtime = { filesystem: filesystem(fixture), disposed: false, dispose: async () => {}, processes: async () => {}, registerAdapter: () => () => {}, registerProgram: () => () => {} };
  const boundary = {
    ...stateModule, ...viewModule, EditorView: View, EditorState,
    ...engineLoader,
    FitAddon: class { fit() {} }, Terminal: TerminalFixture,
    createRuntime: () => (runtime = { ...runtime }),
    BrowserPrograms: class { ready() { return Promise.resolve({ path: "/bin" }); } dispose() { return Promise.resolve(); } },
    registerModuleScope: async () => true,
    loadWasm: async (url: string) => { loads.push(url); return { module: {}, size: 1, build: null }; },
    Previews: class { ready = Promise.resolve("ready"); register() {} unregister() {} url() { return "https://preview.test/"; } },
    HostedPreviews: class {},
    linkLocalUrls() {}, openTerminal() {},
    Shell: class { static async create(options: { onState(state: "ready"): void }) { options.onState("ready"); return { running: false, dispose: async () => {}, submit: async () => {}, input() {}, resize() {} }; } },
    startRun: (options: { args: string[] }) => { const run = { args: options.args, done: deferred<{ code: number }>(), kills: [] as number[] }; runs.push(run); return { done: run.done.promise, kill: (signal: number) => run.kills.push(signal) }; },
    examples: sources, HOME: "/home/user",
    location: { href: "https://example.test/", reloads: 0, reload() { this.reloads++; }, assign() {} },
    requestIdleCallback: () => 0,
    window: { matchMedia: () => ({ matches: false }) },
    addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => { if (type === "pagehide") listeners.push(listener); },
    fetch: async () => new Response(JSON.stringify({ files: sources })),
  };
  const key = `bunwasm-ui-test-${identity++}`;
  Reflect.set(globalThis, key, boundary);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const replacements: Record<string, string[]> = {
    "@codemirror/state": Object.keys(stateModule), "@codemirror/view": Object.keys(viewModule),
    "@xterm/addon-fit": ["FitAddon"], "@xterm/xterm": ["Terminal"],
    waffle: ["createRuntime"], "browser-programs": ["BrowserPrograms"],
    "engine-loader": ["ENGINES", "WasmMissing", "isEngine", "loadWasm", "mb", "registerModuleScope"],
    "preview": ["Previews"], "hosted-previews": ["HostedPreviews"], "terminal-links": ["linkLocalUrls"],
    "terminal-mount": ["openTerminal"],
    "runner": ["startRun"], "shell": ["Shell"], "examples": ["examples", "HOME"],
  };
  const result = await Bun.build({
    entrypoints: ["ui-entry"], target: "bun", format: "esm",
    jsx: { importSource: "@remix-run/component", runtime: "automatic" },
    define: { location: "__boundary.location", window: "__boundary.window", addEventListener: "__boundary.addEventListener", fetch: "__boundary.fetch", requestIdleCallback: "__boundary.requestIdleCallback" },
    plugins: [{ name: "page-boundaries", setup(build) {
      build.onResolve({ filter: /^ui-entry$/ }, () => ({ path: "entry", namespace: "ui" }));
      build.onLoad({ filter: /.*/, namespace: "ui" }, () => ({ contents: `import { renderToString } from ${JSON.stringify(`${root}web/node_modules/@remix-run/component/dist/server.js`)};
import { App as PlaygroundApp } from ${JSON.stringify(`${root}web/src/playground/app.tsx`)};
import { App as SandboxApp } from ${JSON.stringify(`${root}sandbox/src/app.tsx`)};
export const renderPlayground = playground => renderToString(PlaygroundApp({ props: { playground }, signal: new AbortController().signal, update: async () => {} })());
export const renderSandbox = sandbox => renderToString(SandboxApp({ props: { sandbox }, signal: new AbortController().signal, update: async () => {} })());
export { Playground } from ${JSON.stringify(`${root}web/src/playground/playground.ts`)};
export { Sandbox } from ${JSON.stringify(`${root}sandbox/src/sandbox.ts`)};
export { Editor as PlaygroundEditor } from ${JSON.stringify(`${root}web/src/playground/editor.ts`)};
export { Editor as SandboxEditor } from ${JSON.stringify(`${root}sandbox/src/editor.ts`)};
export { loadTemplate } from ${JSON.stringify(`${root}sandbox/src/template.ts`)};
export { runtimeSharedObjectRoute } from ${JSON.stringify(`${root}web/src/shared-objects/runtime.ts`)};`, loader: "ts", resolveDir: root }));
      build.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith("@remix-run/component")) return { path: `${root}web/node_modules/@remix-run/component/dist/${(args.path.split("/")[2] ?? "index").replace("jsx-dev-runtime", "jsx-runtime")}.js` };
        const match = Object.keys(replacements).find(name => args.path === name || args.path.endsWith(`/${name}`));
        return match ? { path: match, namespace: "boundary" } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents: `export const { ${replacements[args.path]!.join(", ")} } = __boundary;`, loader: "ts" }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, "Page model build failed");
  const source = `const __boundary = globalThis[${JSON.stringify(key)}];\n${await result.outputs[0]!.text()}`;
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-392-ui-model-"));
  const modulePath = `${scratch}/models.mjs`;
  await writeFile(modulePath, source);
  const loaded = await import(modulePath);
  const exports = loaded as {
    Playground: typeof Playground; Sandbox: typeof Sandbox;
    renderPlayground(model: Playground): Promise<string>; renderSandbox(model: Sandbox): Promise<string>;
    PlaygroundEditor: typeof import("../src/playground/editor").Editor;
    SandboxEditor: typeof import("../../sandbox/src/editor").Editor;
    loadTemplate: typeof import("../../sandbox/src/template").loadTemplate;
    runtimeSharedObjectRoute(runtime: Pick<Runtime, "filesystem" | "disposed">): ReturnType<typeof import("../src/shared-objects/runtime").runtimeSharedObjectRoute>;
  };
  return { ...exports, fixture, get runtime() { return runtime; }, listeners, loads, runs, boundary, async cleanup() { for (const listener of listeners) listener({ persisted: false }); Reflect.deleteProperty(globalThis, key); for (const run of runs) run.done.resolve({ code: 0 }); await rm(scratch, { recursive: true }); } };
}

export function method<T extends (...args: never[]) => unknown>(target: object, name: string): T {
  const value: unknown = Reflect.get(target, name);
  if (typeof value !== "function") throw new Error(`Missing model method ${name}`);
  return value.bind(target) as T;
}

export async function turn(): Promise<void> { await Bun.sleep(0); }
