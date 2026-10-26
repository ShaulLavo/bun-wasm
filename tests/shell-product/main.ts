import { createShell, SharedBridge, control, runtimeSnapshot, type Shell } from "bash-web";
import { installCat } from "bash-web/utilities/cat";
import { installGrep } from "bash-web/utilities/grep";
import { installBunAdapters, type BunAdapterInstallation, type RuntimeNetworkHelper } from "bun-wasm";
import { createRuntime } from "waffle";
import { PreviewRouter } from "waffle/browser/preview";
import { activated } from "waffle/browser/service-worker";
import type { Fixture } from "./model";
import type { ProductApi } from "./protocol";

const router = new PreviewRouter({ baseURL: location.href, prefix: "__preview" });
const listeners = new Map<number, RuntimeNetworkHelper>();
const workers = new Set<Worker>();
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.add(this); }
  override terminate() { workers.delete(this); super.terminate(); }
};
const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } });
let tailAvailable = false;
const previewMessage = (event: MessageEvent) => router.onMessage(event);
let registration: ServiceWorkerRegistration | undefined;
let installation: BunAdapterInstallation | undefined;
let active: Terminal | undefined;
const transcripts: { app: string; text: string }[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean, label: string, milliseconds = 60000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timeout: ${label}`);
    await delay(10);
  }
}

class Terminal {
  text = "";
  sequence = 0;
  baselineWorkers = workers.size;
  pending: { kind: "command"; token: string; offset: number } | { kind: "server"; offset: number; entered: boolean } | undefined;
  readonly timer: ReturnType<typeof setInterval>;
  constructor(readonly app: string, readonly shell: Shell) {
    this.timer = setInterval(() => this.sample(), 5);
  }
  sample() {
    this.text += new TextDecoder().decode(this.shell.terminal.drain());
    if (this.pending?.kind === "server" && Atomics.load(this.shell.terminal.state, control.phase) !== 1) this.pending.entered = true;
  }
  send(line: string) { check(this.shell.terminal.send(new TextEncoder().encode(`${line}\n`)), "Terminal ring accepted input"); }
  begin(command: string) {
    check(!this.pending, "Previous foreground command must finish first");
    const token = `PRODUCT_DONE_${++this.sequence}`;
    this.pending = { kind: "command", token, offset: this.text.length };
    this.send(`${command}; __product_status=$?; printf '\\n${token}:%s\\n' "$__product_status"`);
  }
  beginServer(command: string) {
    check(!this.pending, "Previous foreground command must finish first");
    this.pending = { kind: "server", offset: this.text.length, entered: false };
    this.send(command);
  }
  serverExited() { return this.pending?.kind === "server" && this.pending.entered && Atomics.load(this.shell.terminal.state, control.phase) === 1; }
  completion() {
    if (this.pending?.kind !== "command") return null;
    const match = new RegExp(`(?:^|\\n)${this.pending.token}:(\\d+)\\r?(?:\\n|$)`).exec(this.text.slice(this.pending.offset));
    return match ? Number(match[1]) : null;
  }
  async finish(milliseconds = 60000) {
    check(this.pending?.kind === "command", "Command has started");
    const pending = this.pending;
    await until(() => this.completion() !== null, pending.token, milliseconds);
    const code = this.completion();
    const output = this.text.slice(pending.offset);
    this.pending = undefined;
    await this.ready();
    return { code, output };
  }
  async ready() { await until(() => Atomics.load(this.shell.terminal.state, control.phase) === 1, "Shell prompt"); }
  async interrupt() {
    // The same terminal-ring interrupt/input path used by a real terminal UI.
    this.shell.terminal.interrupt();
    check(this.shell.terminal.discardInput(), "Interrupted input discarded");
    this.shell.terminal.resumeInput();
    this.shell.interrupt();
    this.pending = undefined;
    await this.ready();
    this.begin("printf 'INTERRUPT_STATUS:%s\\n' \"$?\"");
    const result = await this.finish();
    const status = /INTERRUPT_STATUS:(\d+)/.exec(result.output)?.[1];
    check(status === "0" || status === "130", `Unexpected Ctrl-C status: ${result.output}`);
    check(workers.size === this.baselineWorkers, "Foreground workers physically stopped before prompt");
    check(listeners.size === 0, "Ctrl-C removes guest network listeners before prompt");
    return { ...result, code: Number(status) };
  }
  async dispose() {
    clearInterval(this.timer);
    try { await this.shell.dispose(); }
    finally { this.text += new TextDecoder().decode(this.shell.terminal.drain()); transcripts.push({ app: this.app, text: this.text }); }
  }
}
function terminal() { check(active, "Active interactive shell"); return active; }
async function write(path: string, content: string) {
  await runtime.filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
  await runtime.filesystem.writeFile(path, content);
}
async function setup() {
  check(crossOriginIsolated, "Shared terminal requires cross-origin isolation");
  navigator.serviceWorker.addEventListener("message", previewMessage);
  navigator.serviceWorker.startMessages();
  registration = await navigator.serviceWorker.register("./sw.js", { scope: "./__preview/" });
  await activated(registration);
  const module = await WebAssembly.compileStreaming(fetch("./bun-guest.wasm"));
  installation = await installBunAdapters(runtime, { module, workerUrl: new URL("./worker.js", location.href), network: {
    listening(port, helper) { listeners.set(port, helper); router.register(port, helper); },
    stopped(port, helper) { if (listeners.get(port) === helper) listeners.delete(port); router.unregister(port, helper); },
  } });
  await installCat(runtime, { wasmUrl: "./programs/cat.wasm", workerUrl: "./shell-worker.js" });
  await installGrep(runtime, { wasmUrl: "./programs/grep.wasm", workerUrl: "./shell-worker.js" });
  const capabilities: unknown = await (await fetch("./capabilities.json")).json();
  if (capabilities && typeof capabilities === "object" && "tail" in capabilities && capabilities.tail === true) await registerTail();
  const service = await runtime.processes();
  check(service === await runtime.processes(), "One runtime process service");
  check(await runtime.network() === await runtime.network(), "One runtime network service");
}
async function registerTail() {
  const module: unknown = await import(new URL("./tail-install.js", location.href).href);
  check(module && typeof module === "object" && "install" in module && typeof module.install === "function", "Public standalone tail installer");
  await module.install(runtime);
  tailAvailable = true;
}
async function readFile(path: string) { const bytes = await runtime.filesystem.readFile(path); return bytes ? new TextDecoder().decode(bytes) : null; }
async function open(fixture: Fixture, registry: string) {
  await close();
  const cwd = `/home/guest/${fixture.id}`;
  for (const [path, source] of Object.entries(fixture.files)) await write(`${cwd}/${path}`, source);
  await write(`${cwd}/package.json`, JSON.stringify({ name: `shell-product-${fixture.id}`, private: true, type: "module", dependencies: fixture.dependencies, scripts: fixture.scripts }));
  await write(`${cwd}/.npmrc`, `registry=${registry}\n`);
  await runtime.filesystem.flush();
  const bridge = new SharedBridge();
  Atomics.store(bridge.state, control.cols, 120); Atomics.store(bridge.state, control.rows, 24);
  active = new Terminal(fixture.id, await createShell({ runtime, cwd, env: { PATH: "/bin:/usr/bin", HOME: "/home/guest", PS1: "PRODUCT> ", PORT: "3137", NEXT_TELEMETRY_DISABLED: "1" }, terminal: bridge, wasmUrl: "./programs/shell-engine.wasm", workerUrl: "./shell-worker.js" }));
  await active.ready();
}
async function close() { const session = active; active = undefined; await session?.dispose(); }
async function command(text: string, milliseconds?: number) { const session = terminal(); session.begin(text); return session.finish(milliseconds); }
async function start(command: string, port: number, milliseconds: number) {
  const session = terminal(); session.beginServer(command);
  await until(() => listeners.has(port) || session.serverExited(), `Listener ${port}`, milliseconds);
  if (!listeners.has(port)) { session.pending = undefined; throw new Error(`Server exited before listener: ${session.text}`); }
  return router.url(port);
}
function diagnostics() { return { tailAvailable, transcripts: transcripts.concat(active ? [{ app: active.app, text: active.text }] : []), listeners: Array.from(listeners.keys()), workers: workers.size, runtime: runtimeSnapshot(runtime), pending: active?.pending }; }
async function cleanup() {
  try { await close(); installation?.dispose(); }
  finally { await runtime.dispose(); navigator.serviceWorker.removeEventListener("message", previewMessage); await registration?.unregister(); }
  check(workers.size === 0, `Remaining workers: ${workers.size}`);
  check(listeners.size === 0, `Remaining listeners: ${listeners.size}`);
  return { workers: workers.size, listeners: listeners.size };
}
export const shellProduct = { setup, open, command, start, readFile, interrupt: () => terminal().interrupt(), close, diagnostics, cleanup } satisfies ProductApi;
Reflect.set(globalThis, "shellProduct", shellProduct);
