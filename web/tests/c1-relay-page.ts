import { createRuntime } from "waffle";
import { loadBunWasm, parseBunWasmAsset } from "../../src/assets";
import { startRun, type Run } from "../src/runner";
import { runtimeRelay } from "../src/net/relay";
import type { BunNetworkOptions } from "../src/net/helper";
import { isEngine } from "../src/engine-loader";
import { assertCarrier, databaseEnvironment, localhostOrigin, modes, type C1Carrier, type C1Mode, type C1PageConfig } from "./fixtures/c1-relay/protocol";
import { pgQuery, noRelay } from "./fixtures/c1-relay/guests";

const workers = new Set<Worker>();
const NativeWorker = globalThis.Worker;
const abort = new AbortController();
let running: Promise<unknown> | undefined;
const tokens = new Set<string>();

function checkWorkerData(value: unknown): void {
  if (typeof value === "function" || typeof value === "string" && tokens.has(value)) throw new Error("C1 worker received a page capability");
  if (!value || typeof value !== "object") return;
  if (value instanceof ReadableStream || value instanceof WritableStream) throw new Error("C1 worker received a stream");
  if (value instanceof WebAssembly.Module || value instanceof MessagePort || value instanceof ArrayBuffer
    || value instanceof SharedArrayBuffer || ArrayBuffer.isView(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["token", "password", "endpoint", "relay", "getToken"].includes(key)) throw new Error("C1 worker received private page configuration");
    checkWorkerData(child);
  }
}

globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.add(this); }
  override postMessage(value: unknown, transfer: Transferable[]): void;
  override postMessage(value: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    checkWorkerData(value);
    if (Array.isArray(options)) super.postMessage(value, options);
    else super.postMessage(value, options);
  }
  override terminate(): void { workers.delete(this); super.terminate(); }
};

function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function json(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store" });
  check(response.ok, "C1 local fixture response failed");
  return response.json();
}
async function config(): Promise<C1PageConfig> {
  localhostOrigin(location.origin);
  check(crossOriginIsolated, "C1 requires an isolated localhost page");
  const value = await json("/config");
  check(value && typeof value === "object" && "asset" in value && "engine" in value && "endpoint" in value, "Invalid C1 page configuration");
  check(typeof value.engine === "string" && isEngine(value.engine), "Invalid C1 engine");
  check(typeof value.endpoint === "string", "Invalid C1 relay endpoint");
  localhostOrigin(value.endpoint);
  check("preview1" in value && value.preview1 && typeof value.preview1 === "object", "Missing owner Preview 1 contract");
  const plain = value.preview1;
  check("target" in plain && plain.target && typeof plain.target === "object" && "host" in plain.target && typeof plain.target.host === "string"
    && "port" in plain.target && typeof plain.target.port === "number" && "expectedStdout" in plain && typeof plain.expectedStdout === "string", "Invalid owner Preview 1 contract");
  return { asset: parseBunWasmAsset(value.asset), engine: value.engine, endpoint: value.endpoint,
    preview1: { target: { host: plain.target.host, port: plain.target.port }, expectedStdout: plain.expectedStdout } };
}
async function getToken(): Promise<string> {
  const response = await fetch("/token", { method: "POST", cache: "no-store" });
  check(response.ok, "C1 local token request failed");
  const token = await response.text();
  tokens.add(token);
  return token;
}

async function guestDatabaseEnvironment(): Promise<{ PGPASSWORD: string }> {
  const response = await fetch("/database", { method: "POST", cache: "no-store" });
  check(response.ok, "C1 private database configuration failed");
  return databaseEnvironment(await response.json());
}

async function seed(runtime: ReturnType<typeof createRuntime>): Promise<void> {
  const files = await json("/seed");
  check(Array.isArray(files) && files.every(path => typeof path === "string"), "Invalid C1 seed manifest");
  await runtime.filesystem.mkdirp("/home/user");
  for (const path of files) {
    check(typeof path === "string" && path.startsWith("node_modules/") && !path.split("/").includes(".."), "Unsafe C1 seed path");
    const response = await fetch(`/seed/${path}`);
    check(response.ok, "Missing C1 pg package file");
    const target = `/home/user/${path}`;
    await runtime.filesystem.mkdirp(target.slice(0, target.lastIndexOf("/")));
    await runtime.filesystem.writeFile(target, new Uint8Array(await response.arrayBuffer()));
  }
  await runtime.filesystem.writeFile("/home/user/query.ts", pgQuery);
  await runtime.filesystem.flush();
}

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(label)), ms);
  try { return await Promise.race([promise, expired.promise]); }
  finally { clearTimeout(timer); }
}

async function scenario(selected: C1PageConfig, module: WebAssembly.Module, mode: C1Mode) {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } });
  const runs: Run[] = [];
  const observed: C1Carrier[] = [];
  const network: BunNetworkOptions | undefined = mode === "no-relay" ? undefined : { relay: {
    endpoint: selected.endpoint, getToken, carriers: mode === "websocket" ? ["websocket"] : ["webtransport", "websocket"],
    connectTimeoutMs: 15_000, onCarrier: carrier => observed.push(carrier),
  } };
  let relay: Awaited<ReturnType<typeof runtimeRelay>>;
  let output = "";
  const hooks = { stdout: (bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); }, stderr() {} };
  const stop = () => { for (const run of runs) run.kill(9); };
  abort.signal.addEventListener("abort", stop, { once: true });
  try {
    abort.signal.throwIfAborted();
    relay = await runtimeRelay(runtime, network?.relay);
    if (mode === "no-relay") await runtime.filesystem.mkdirp("/home/user");
    else await seed(runtime);
    abort.signal.throwIfAborted();
    const database = mode === "no-relay" ? {} : await guestDatabaseEnvironment();
    abort.signal.throwIfAborted();
    const query = startRun({ runtime, module, engine: selected.engine, moduleScope: false,
      args: mode === "no-relay" ? ["-e", noRelay] : ["/home/user/query.ts"], env: { PWD: "/home/user", HOME: "/home/user", PATH: "/bin:/usr/bin", ...database }, network }, hooks);
    runs.push(query);
    const result = await bounded(query.done, 90_000, "C1 Bun command deadline");
    check(result.code === 0 && !result.error, "C1 Bun command failed");
    check(output.includes(mode === "no-relay" ? "C1_NO_RELAY_LOOPBACK_ENOTSUP_OK" : "C1_PG_SELECT_1_OK"), "C1 Bun result missing");
    if (mode !== "no-relay") await preview1(runtime, selected, network, runs);
    assertCarrier(mode, observed, mode === "no-relay" ? 0 : 2);
    return { mode, carriers: observed, query: mode === "no-relay" ? "loopback and ENOTSUP" : "SELECT 1", bunPreview1Adapter: mode !== "no-relay" };
  } finally {
    abort.signal.removeEventListener("abort", stop);
    stop();
    const cleanup = await Promise.allSettled([bounded(runtime.dispose(), 15_000, "C1 runtime cleanup deadline"),
      bounded(Promise.all(runs.map(run => run.done)), 15_000, "C1 process cleanup deadline")]);
    await bounded(relay?.close() ?? Promise.resolve(), 15_000, "C1 relay cleanup deadline");
    const failed = cleanup.filter(row => row.status === "rejected");
    check(failed.length === 0 && workers.size === 0, "C1 helper/owner/runtime cleanup unconfirmed");
  }
}

async function preview1(runtime: ReturnType<typeof createRuntime>, selected: C1PageConfig, network: BunNetworkOptions | undefined, runs: Run[]): Promise<void> {
  const response = await fetch("/line.wasm");
  check(response.ok, "Missing C1 Preview 1 line fixture");
  const module = await WebAssembly.compileStreaming(response);
  let output = "";
  const run = startRun({ runtime, module, engine: selected.engine, adapter: "preview1", args: [], env: { PWD: "/home/user" },
    moduleScope: false, network, preview1: { sockets: [{ fd: 3, socket: { connect: selected.preview1.target } }] } },
  { stdout: bytes => { output += new TextDecoder().decode(bytes); }, stderr() {} });
  runs.push(run);
  const result = await bounded(run.done, 30_000, "C1 Preview 1 deadline");
  check(result.code === 0 && !result.error && output === selected.preview1.expectedStdout, "C1 Bun manual-launcher Preview 1 outside-echo adapter failed");
}

async function run() {
  const selected = await config();
  const module = await loadBunWasm({ asset: selected.asset, fetch: url => {
    const hash = new URL(url).pathname.split("/")[1];
    return fetch(`/artifacts/${hash}`);
  } });
  const rows = [];
  for (const mode of modes) rows.push(await scenario(selected, module, mode));
  return { ok: true, rows, cleanup: { workers: workers.size, runtimeDisposed: true, relayClosed: true }, userAgent: navigator.userAgent };
}

Reflect.set(globalThis, "c1Relay", { run: () => running ??= run(), cancel: () => abort.abort(new Error("C1 cancelled")) });
const control = setInterval(() => { void json("/control").then(value => { if (value === "stop") abort.abort(new Error("C1 fixture stopping")); }).catch(() => abort.abort(new Error("C1 controller disconnected"))); }, 500);
try {
  const result = await (running = run());
  document.body.textContent = JSON.stringify(result, null, 2);
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
} catch {
  const result = { ok: false, cleanup: { workers: workers.size }, error: "C1 failed; do not claim acceptance" };
  document.body.textContent = JSON.stringify(result);
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
} finally { clearInterval(control); tokens.clear(); }
