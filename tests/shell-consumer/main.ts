import { installCat } from "bash-web/utilities/cat";
import { installMkdir } from "bash-web/utilities/mkdir";
import { createShell, SharedBridge, control, OUTPUT_CAPACITY, runtimeSnapshot, type Shell } from "bash-web";
import { installBunAdapters, type BunAdapterInstallation, type RuntimeNetworkHelper } from "bun-wasm";
import { createRuntime, type ProcessAdmissionEvent, type RuntimeSupervisor } from "waffle";
import { PreviewRouter } from "waffle/browser/preview";
import { activated } from "waffle/browser/service-worker";
import { binaryBytes, commands, guests, previewPort } from "./guests";
import { MessageListenerProbe } from "./message-listener-probe";

const workers = new Map<Worker, string>();
const created: string[] = [];
const pipes = new Map<string, { capacity: number; bytes: number }>();
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers.set(this, String(url)); created.push(String(url));
    this.addEventListener("message", (event: MessageEvent<unknown>) => observePipe(event.data));
  }
  override terminate() { workers.delete(this); super.terminate(); }
};
function observePipe(data: unknown) {
  if (!data || typeof data !== "object" || !("operation" in data) || data.operation !== "pipe" || !("handle" in data)) return;
  const handle = data.handle;
  if (!handle || typeof handle !== "object" || !("id" in handle) || typeof handle.id !== "string") return;
  if (!("capacity" in handle) || typeof handle.capacity !== "number" || !("buffer" in handle) || !(handle.buffer instanceof SharedArrayBuffer)) return;
  pipes.set(handle.id, { capacity: handle.capacity, bytes: handle.buffer.byteLength });
}
const admissions: ProcessAdmissionEvent[] = [];
const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
  onProcessAdmission(event) { if (admissions.length < 1024) admissions.push(event); },
});
const router = new PreviewRouter({ baseURL: location.href, prefix: "__preview" });
const listeners = new Map<number, RuntimeNetworkHelper>();
const previewListener = new MessageListenerProbe(navigator.serviceWorker, event => router.onMessage(event));
let registration: ServiceWorkerRegistration | undefined;
let installation: BunAdapterInstallation | undefined;
let supervisor: RuntimeSupervisor | undefined;
let borrower: Session | undefined;
const sessions = new Set<Session>();
const results: { name: string; ok: boolean; detail: unknown }[] = [];
const ancestry = new Map<number, { pid: number; parentPid: number; job: number; argv: readonly string[] }>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean, label: string, milliseconds = 30000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`deadline: ${label}`);
    await delay(5);
  }
}
class Session {
  text = "";
  exited = false;
  peakTerminal = 0;
  peakPipes = 0;
  peakShellMemory = 0;
  firstTickWhileLive = false;
  captureTruncated = false;
  readonly shell: Shell;
  readonly timer: ReturnType<typeof setInterval>;
  constructor(shell: Shell) {
    this.shell = shell;
    sessions.add(this);
    void shell.done.then(() => { this.exited = true; });
    this.timer = setInterval(() => this.sample(), 5);
  }
  sample() {
    const state = this.shell.terminal.state;
    this.peakTerminal = Math.max(this.peakTerminal, (Atomics.load(state, control.outputWrite) - Atomics.load(state, control.outputRead)) >>> 0);
    const bytes = this.shell.terminal.drain();
    this.text += new TextDecoder().decode(bytes);
    if (this.text.length > 65536) { this.captureTruncated = true; this.text = this.text.slice(-65536); }
    if (runtime.disposed) return;
    const snapshot = runtimeSnapshot(runtime);
    this.peakPipes = Math.max(this.peakPipes, ...snapshot.roots.map(root => root.pipes));
    this.peakShellMemory = Math.max(this.peakShellMemory, ...snapshot.roots.map(root => root.memoryBytes));
    for (const record of supervisor?.table.values() ?? []) ancestry.set(record.pid, { pid: record.pid, parentPid: record.parentPid, job: record.job, argv: record.request?.argv ?? [] });
    const producer = Array.from(supervisor?.table.values() ?? []).find(record => record.request?.argv.includes("/fixtures/ticker.ts") && record.parentPid === this.shell.process.pid);
    if (this.text.includes("FILTER:TICK:0") && producer?.state === "running" && !producer.result) this.firstTickWhileLive = true;
  }
  async send(line: string) {
    check(this.shell.terminal.send(new TextEncoder().encode(line + "\n")), "terminal input fits ring");
    await delay(10);
  }
  async ready() { await until(() => Atomics.load(this.shell.terminal.state, control.phase) === 1, "usable shell prompt"); this.sample(); }
  async output(text: string) { await until(() => this.text.includes(text), text); }
  async finish() {
    await until(() => this.exited, `shell ${this.shell.process.pid} exit: ${this.text}`);
    this.sample();
    const result = await this.shell.done;
    check(!this.captureTruncated, "terminal capture limit exceeded");
    check(runtimeSnapshot(runtime).droppedTerminalBytes === 0, "terminal never drops output");
    check(result.code === 0, `shell status ${result.code}: ${this.text}`);
    return this.text;
  }
  async dispose() {
    try { await this.shell.dispose(); }
    finally { clearInterval(this.timer); this.sample(); sessions.delete(this); }
  }
  stats() { return { pid: this.shell.process.pid, output: this.text, peakTerminal: this.peakTerminal, peakPipes: this.peakPipes, peakShellMemory: this.peakShellMemory }; }
}
async function session(script?: string) {
  const terminal = new SharedBridge();
  Atomics.store(terminal.state, control.cols, 120); Atomics.store(terminal.state, control.rows, 24);
  return new Session(await createShell({ runtime, script, cwd: "/home/guest", env: { PATH: "/bin:/usr/bin", HOME: "/home/guest", PS1: "SHELL> " }, terminal, wasmUrl: "./programs/shell-engine.wasm", workerUrl: "./shell-worker.js" }));
}
async function run<T>(script: string, verify: (shell: Session) => Promise<T>) {
  const shell = await session(script);
  try { return await verify(shell); }
  catch (error) { throw new Error(`${String(error)}; command: ${script}; output: ${shell.text}`); }
  finally { await shell.dispose(); }
}
async function outputCase(script: string, expected: readonly string[]) {
  return run(script, async shell => {
    const text = await shell.finish();
    for (const fragment of expected) check(text.includes(fragment), `missing ${JSON.stringify(fragment)}: ${text}`);
    return shell.stats();
  });
}
async function ticker() {
  return run(commands.ticker, async shell => {
    await shell.output("FILTER:TICK:0");
    check(shell.firstTickWhileLive, "filter delivers output before producer exit");
    const text = await shell.finish();
    check(text.includes("FILTER:PRODUCER_EXIT"), "producer eventually exits");
    return { ...shell.stats(), firstTickWhileLive: shell.firstTickWhileLive };
  });
}
async function binary() {
  const detail = await outputCase(commands.binary, [`BINARY_EXACT:${binaryBytes}`, "BINARY_STATUS:0:0 0"]);
  check(detail.peakTerminal <= OUTPUT_CAPACITY, "bounded terminal queue");
  check(detail.peakPipes <= 4, "bounded simultaneous observed shell pipes");
  check(pipes.size > 0, "observed actual runtime pipe allocations");
  for (const pipe of pipes.values()) check(pipe.capacity <= 65536 && pipe.bytes <= 8 * 1024 * 1024, "fixed bounded pipe allocation");
  return { ...detail, exactBytes: binaryBytes, pipes: Array.from(pipes.values()) };
}
async function changed(path: string) {
  const before = await runtime.filesystem.readFile(path);
  let after = before;
  const deadline = performance.now() + 5000;
  while (String(after) === String(before) && performance.now() < deadline) { await delay(30); after = await runtime.filesystem.readFile(path); }
  check(String(after) !== String(before), `survivor heartbeat advances: ${path}`);
}
async function interrupt() {
  const shell = await session();
  try {
    await shell.ready();
    await shell.send("bun run /fixtures/background.ts &");
    await shell.output("INDEPENDENT_READY"); await shell.ready();
    const background = Array.from(supervisor!.table.values()).filter(record => !record.result).map(record => record.pid);
    const baselineWorkers = workers.size;
    await shell.send("bun run /fixtures/parent.ts");
    await shell.output("PARENT_READY"); await shell.output("DESCENDANT_READY");
    const foreground = Array.from(supervisor!.table.values()).filter(record => !record.result && !background.includes(record.pid));
    check(foreground.length === 2, "parent and nested Bun are both admitted");
    shell.shell.terminal.interrupt();
    check(shell.shell.terminal.discardInput(), "discard interrupted input");
    shell.shell.terminal.resumeInput(); shell.shell.interrupt();
    await shell.ready();
    check(workers.size === baselineWorkers, "prompt follows physical foreground worker stop");
    check(foreground.every(record => !Array.from(supervisor!.table.values()).some(current => current.pid === record.pid && !current.result)), "foreground descendants stopped before prompt");
    await changed("/background-alive");
    await shell.send("echo DESCENDANT_STATUS:$?; kill %1; wait; echo DESCENDANTS_REAPED");
    await shell.output("DESCENDANT_STATUS:130"); await shell.output("DESCENDANTS_REAPED"); await shell.ready();
    check(workers.size === baselineWorkers - 1, "wait reaps the unrelated background worker");
    await shell.send("echo PROMPT_USABLE"); await shell.output("\nPROMPT_USABLE"); await shell.ready();
    return { ...shell.stats(), status: 130, foreground: foreground.map(({ pid, parentPid, job }) => ({ pid, parentPid, job })), background };
  } finally { await shell.dispose(); }
}
let preview: Session | undefined;
async function startPreview() {
  preview = await session("bun run /fixtures/preview.ts");
  await preview.output("PREVIEW_READY");
  await until(() => listeners.has(previewPort), "preview registered on shared runtime network");
  check(!preview.exited, "preview process remains live");
  return { url: router.url(previewPort), ...preview.stats() };
}
async function record(name: string, execute: () => Promise<unknown>) {
  try { results.push({ name, ok: true, detail: await execute() }); }
  catch (error) { results.push({ name, ok: false, detail: String(error) }); }
}
async function setup() {
  check(crossOriginIsolated, "cross-origin isolation");
  navigator.serviceWorker.addEventListener("message", previewListener.listener);
  check(previewListener.count() === 1, "page listener probe reaches the registered preview handler");
  navigator.serviceWorker.startMessages();
  registration = await navigator.serviceWorker.register("./sw.js", { scope: "./__preview/" });
  await activated(registration);
  const module = await WebAssembly.compileStreaming(fetch("./bun-guest.wasm"));
  installation = await installBunAdapters(runtime, { module, workerUrl: new URL("./worker.js", location.href), notificationWorkerUrl: new URL("./notification-worker.js", location.href), network: {
    listening(port, helper) { listeners.set(port, helper); router.register(port, helper); },
    stopped(port, helper) { if (listeners.get(port) === helper) listeners.delete(port); router.unregister(port, helper); },
  } });
  await installCat(runtime, { wasmUrl: "./programs/cat.wasm", workerUrl: "./shell-worker.js" });
  await installMkdir(runtime, { wasmUrl: "./programs/mkdir.wasm", workerUrl: "./shell-worker.js" });
  await runtime.filesystem.mkdirp("/home/guest"); await runtime.filesystem.mkdirp("/fixtures");
  for (const [path, source] of Object.entries(guests)) await runtime.filesystem.writeFile(`/fixtures/${path}`, source);
  await runtime.filesystem.flush();
  const service = await runtime.processes();
  check(service === await runtime.processes(), "one shared process service");
  check(await runtime.network() === await runtime.network(), "one shared network service");
  supervisor = await service.ready();
  borrower = await session("bun run /fixtures/survivor.ts"); await borrower.output("BORROWER_READY");
  check(created.filter(url => url.endsWith("/fs-worker.js")).length === 1, "one filesystem worker for both packages");
}
async function exercise() {
  await setup();
  await record("lookup", () => outputCase(commands.lookup, ["EXTERNAL_OK"]));
  await record("files-cwd-env-exit9", () => outputCase(commands.files, ["FILE_STATUS:9", "CONTEXT:/home/guest/demo:from-shell", "source", "created", "DELETE_OK", "MERGED:sourceappended"]));
  await record("epipe", () => outputCase(commands.epipe, ["first", "STATUS:1:1 0"]));
  await record("nested-stdin", () => outputCase(commands.stdin, ["NESTED_STDIN:payload"]));
  await record("live-ticker", ticker);
  await record("binary", binary);
  await record("interrupt", interrupt);
  await record("preview", startPreview);
  return diagnostics();
}
function diagnostics() {
  return { results, runtime: runtimeSnapshot(runtime), admissions, ancestry: Array.from(ancestry.values()), workers: Array.from(workers.values()), created, listeners: Array.from(listeners.keys()), sessions: Array.from(sessions, item => item.stats()) };
}
async function cleanup() {
  try {
    for (const shell of Array.from(sessions)) if (shell !== borrower) await shell.dispose();
    installation?.dispose();
    check(borrower && !borrower.exited && !runtime.disposed, "adapter and shell disposal preserve borrowed consumer");
    await changed("/borrower-alive");
  } finally {
    await runtime.dispose();
    for (const shell of Array.from(sessions)) await shell.dispose();
    navigator.serviceWorker.removeEventListener("message", previewListener.listener);
    await registration?.unregister();
  }
  check(workers.size === 0, `zero owned workers, got ${workers.size}`);
  check(listeners.size === 0, `zero guest listeners, got ${listeners.size}`);
  return { workers: workers.size, listeners: listeners.size, pageListeners: previewListener.assertRemoved(), sessions: sessions.size, borrowerPreservedUntilOwnerDisposal: true };
}
Reflect.set(globalThis, "shellConsumer", { exercise, cleanup, diagnostics });
