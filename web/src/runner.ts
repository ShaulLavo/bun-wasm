// Running bun.wasm from a page: loading the engine's wasm, and starting one `bun …` command in a
// fresh worker with its networking (fetch, Bun.serve previews). Shared by the playground (main.ts)
// and the sandbox (../sandbox/).

import type { Runtime } from "waffle";
import { NetHelper } from "./net/helper";
import { createRing } from "./net/ring";
import { activated } from "./preview";
import { assetBuild, cachedEngine, cacheEngine, evictEngine } from "./startup-cache";
import { measureStartup } from "./startup";
import { SubprocessBroker } from "./subprocess-broker";
import { isToolCommand } from "./tool-command";
import { ENGINE_BIN, engineEnvironment } from "../../src/executable-paths.js";
import { claimOutcome, readOutcome, type OutcomeWord } from "waffle/proc/outcome";
import { waitStatus } from "waffle/proc/wait-status";
import type { Engine, RunRequest, WorkerMessage } from "./bun-executor";

export type { Engine } from "./bun-executor";

/** What each `?engine=` loads. The browser engine runs the program in the page's own JS engine. */
export const ENGINES: Record<Engine, { name: string; wasm: string; script: string }> = {
  quickjs: { name: "QuickJS", wasm: "bun.wasm", script: "scripts/build.sh" },
  jsc: { name: "JavaScriptCore", wasm: "bun-jsc.wasm", script: "scripts/build-bun-jsc.sh" },
  browser: { name: "Browser (native)", wasm: "bun-browser.wasm", script: "scripts/build-bun-browser.sh" },
};

export function isEngine(name: string | null): name is Engine {
  return name !== null && Object.hasOwn(ENGINES, name);
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class WasmMissing extends Error {}

let toolsModule: Promise<WebAssembly.Module> | undefined;
function loadTools(): Promise<WebAssembly.Module> {
  return toolsModule ??= loadWasm("bun-tools.wasm", () => {})
    .then(result => result.module)
    .catch(error => { toolsModule = undefined; throw error; });
}

/**
 * Fetches and compiles a wasm module. Sites ship it gzipped (static hosts cap file sizes, and it is
 * 3-4x smaller) and the page decompresses it; a plain .wasm URL works too. Throws WasmMissing on 404.
 */
export async function loadWasm(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string | null }> {
  if (url.endsWith("bun-tools.wasm")) return loadVerifiedTools(url, progress);
  progress("loading bun.wasm…");
  const build = assetBuild(url);
  const key = new URL(url, location.href).href;
  const cached = build ? await cachedEngine(key, build) : null;
  let size = 0;
  if (cached) {
    progress("compiling cached bun.wasm…");
    const started = performance.now();
    try {
      size = Number(cached.headers.get("content-length"));
      const module = await WebAssembly.compileStreaming(cached);
      performance.mark("bunwasm:engine-cache-hit");
      measureStartup("compile", started, { cached: true });
      return { module, size, build };
    } catch {
      await evictEngine(key);
    }
  }
  progress("downloading bun.wasm…");
  const started = performance.now();
  const gzUrl = url.endsWith(".gz") ? url : `${url}.gz`;
  // The build hash in the query gives every build its own URL, so a CDN edge that still holds the
  // previous build right after a deploy can't serve it in place of this one.
  let res = await fetch(build ? `${gzUrl}?v=${build}` : gzUrl);
  const gzipped = res.ok;
  if (!gzipped) res = await fetch(url);
  if (res.status === 404) throw new WasmMissing(`${url}: HTTP 404`);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  let lastProgress = 0;
  const counter = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      received += chunk.length;
      if (performance.now() - lastProgress >= 50 || received === total) {
        progress(`downloading bun.wasm… ${mb(received)}${total ? ` / ${mb(total)}` : ""}`);
        lastProgress = performance.now();
      }
      controller.enqueue(chunk);
    },
    flush() {
      measureStartup("download", started, { bytes: received });
      progress("decompressing and compiling bun.wasm…");
    },
  });
  if (!res.body) throw new Error(`${url}: empty response body`);
  let body = res.body.pipeThrough(counter);
  const decompressing = performance.now();
  if (gzipped) body = body.pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  body = body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      size += chunk.length;
      if (build) chunks.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      measureStartup("decompress", decompressing, { bytes: size, gzipped });
      progress(`compiling bun.wasm (${mb(size)})…`);
    },
  }));
  // Compilation consumes the decompressed stream while the remaining bytes are still arriving.
  const compiling = performance.now();
  const response = new Response(body, { headers: { "content-type": "application/wasm" } });
  const module = await WebAssembly.compileStreaming(response);
  measureStartup("compile", compiling, { streaming: true });
  const engine = { module, size };
  if (build) setTimeout(() => void cacheIfExpected(key, build, chunks, size), 0);
  return { ...engine, build };
}

async function loadVerifiedTools(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string }> {
  const build = assetBuild(url);
  if (!build) throw new Error("bun-tools.wasm: build manifest fingerprint is missing");
  const key = new URL(url, location.href).href;
  const cached = await cachedEngine(key, build);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    try { await verifyArtifact("bun-tools.wasm", bytes, build); }
    catch (error) { await evictEngine(key); throw error; }
    progress(`compiling cached bun-tools.wasm (${mb(bytes.length)})…`);
    return { module: await WebAssembly.compile(bytes), size: bytes.length, build };
  }
  progress("downloading bun-tools.wasm…");
  const gzUrl = url.endsWith(".gz") ? url : `${url}.gz`;
  let response = await fetch(`${gzUrl}?v=${build}`);
  const gzipped = response.ok;
  if (!gzipped) response = await fetch(url);
  if (response.status === 404) throw new WasmMissing(`${url}: HTTP 404`);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${url}: empty response body`);
  const body = gzipped ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
  const wasm = new Uint8Array(await new Response(body).arrayBuffer());
  await verifyArtifact("bun-tools.wasm", wasm, build);
  progress(`compiling bun-tools.wasm (${mb(wasm.length)})…`);
  const module = await WebAssembly.compile(wasm);
  if (await cacheEngine(key, build, new Response(wasm, { headers: { "content-type": "application/wasm", "content-length": String(wasm.length) } }))) {
    performance.mark("bunwasm:engine-cache-stored", { detail: { url: key, build } });
  }
  return { module, size: wasm.length, build };
}

async function verifyArtifact(name: string, bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<void> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actual = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error(`${name} integrity mismatch: expected ${expected}, received ${actual}`);
}

/** Caches the downloaded engine only if its bytes are the build the page expects. */
async function cacheIfExpected(key: string, build: string, chunks: Uint8Array<ArrayBuffer>[], size: number): Promise<void> {
  const blob = new Blob(chunks);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== build) return;
  const headers = { "content-type": "application/wasm", "content-length": String(size) };
  await cacheEngine(key, build, new Response(blob, { headers }));
}

// The service worker at ./__bunwasm/ (sw.ts) serves named module URLs for import cycles.
// Acyclic modules use blob URLs, including when WebKit starts an uncontrolled worker in the scope.
const MODULE_SCOPE = "./__bunwasm/";

export async function registerModuleScope(): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (!container) return false;
  try {
    const registration = await container.register("./sw.js", { scope: MODULE_SCOPE });
    await activated(registration);
    return registration.active !== null;
  } catch (err) {
    console.warn("module service worker registration failed:", err);
    return false;
  }
}

export interface RunOptions {
  engine: Engine;
  module: WebAssembly.Module;
  /** Arguments after `bun`. */
  args: string[];
  env: Record<string, string>;
  /** Shared service owned by the page, also used by editor and shell. */
  runtime: Runtime;
  /** From registerModuleScope(): run the worker under ./__bunwasm/. */
  moduleScope: boolean;
  trace?: boolean;
  /** Skip Bun host slots for arbitrary Preview1 guests. */
  adapter?: RunRequest["adapter"];
  /** An existing process transport to root the run at; the run creates one otherwise. */
  runtimeProcess?: RunRequest["runtimeProcess"];
}

export interface RunHooks {
  phase?(name: string, duration: number): void;
  stdout(data: Uint8Array): void;
  stderr(data: Uint8Array): void;
  /** A guest server started listening; `helper` delivers requests to it. */
  listening?(port: number, helper: NetHelper): void;
  stopped?(port: number, helper: NetHelper): void;
}

export interface RunResult {
  code: number;
  /** Set when bun.wasm crashed or the worker failed to start. */
  error?: string;
}

export interface Run {
  readonly done: Promise<RunResult>;
  /** Signal the foreground job with SIGINT; a second call or explicit 9 force-kills it. */
  kill(signal?: 2 | 9 | 15): void;
}

/** `?slots=table|off` on the page: how the wasm engines get host functions (see RunRequest.slots). */
function slotsMode(): RunRequest["slots"] {
  const value = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("slots");
  return value === "table" || value === "off" ? value : "imports";
}

const registeredPrograms = new WeakMap<Runtime, Set<string>>();

/** Starts `bun <args>` in a fresh worker, rooting a process tree in the page's runtime. */
export function startRun(options: RunOptions, hooks: RunHooks): Run {
  const ring = globalThis.crossOriginIsolated === true ? createRing() : null;
  const helper: NetHelper | null = ring
    ? new NetHelper(ring, {
        listening: (port) => hooks.listening?.(port, helper!),
        stopped: (port) => hooks.stopped?.(port, helper!),
      })
    : null;
  // One Cache Storage cache per run holds its modules; deleted when the run ends.
  const moduleCache = options.moduleScope ? `bunwasm-m-${crypto.randomUUID()}` : null;
  // The runtime exists only on an isolated page, so every run roots a process tree. The root
  // worker, its children and the shell all spawn through the same service; its transport and
  // client chunks load on first use rather than with the page.
  const filesystemIdentity = (options.runtimeProcess?.data as { filesystem?: import("waffle/fs").FilesystemIdentity } | undefined)?.filesystem;
  const pid = options.runtime.identities.pid(), job = options.runtime.identities.job();
  const request: RunRequest = {
    engine: options.engine,
    adapter: options.adapter,
    runtimeProcess: options.runtimeProcess,
    module: options.module,
    args: [`${ENGINE_BIN[options.engine]}/bun`].concat(options.args),
    env: { ...engineEnvironment(options.engine, options.env), BUNWASM_EXEC_PATH: `${ENGINE_BIN[options.engine]}/bun` },
    filesystem: filesystemIdentity ? options.runtime.filesystem.connect(filesystemIdentity) : options.runtime.filesystem.fork(),
    trace: options.trace ?? false,
    net: ring,
    moduleCache,
    slots: slotsMode(),
  };
  let rootOutcome: OutcomeWord | null = null;
  let rootPid = pid, rootJob = job;
  const workerUrl = new URL(options.moduleScope ? `${MODULE_SCOPE}worker.js` : "./worker.js", location.href).href;
  let rootAcknowledged = false;
  let rootQuiescence: Promise<void> | undefined;
  let rootStopped = false;
  let rootConsumerRelease: (() => void) | undefined;
  const quiesceRoot = (): void | Promise<void> => {
    if (rootAcknowledged) return;
    return rootQuiescence ??= options.runtime.filesystem.quiesce(request.filesystem);
  };
  let workerStopped = false;
  const releaseRootConsumer = () => { rootConsumerRelease?.(); rootConsumerRelease = undefined; };
  const stopWorker = () => {
    if (workerStopped) return;
    workerStopped = true;
    request.filesystem.port.close();
    worker.terminate();
  };
  const stopRoot = () => { if (rootStopped) return; rootStopped = true; stopWorker(); };
  rootConsumerRelease = options.runtime.retainConsumer({
    filesystem: request.filesystem,
    revoke: () => { if (!finished) finish({ code: 137 }, false, 9, true); },
    stop: stopRoot,
  });
  const subprocess = new SubprocessBroker(workerUrl, options.runtime, {
    loadTools,
    rootFilesystem: request.filesystem, rootAcknowledged: () => rootAcknowledged,
    stopRoot: () => finish({ code: rootOutcome ? readOutcome(rootOutcome)?.status ?? 137 : 137 }, false, undefined, true),
    output: (fd, data) => (fd === 2 ? hooks.stderr : hooks.stdout)(data),
  });
  // Real engine executables are registered once per runtime. Each root inherits an ordinary
  // PATH selecting its engine; explicit absolute paths are never rewritten.
  let programs = registeredPrograms.get(options.runtime);
  if (!programs) registeredPrograms.set(options.runtime, programs = new Set());
  for (const engine of ["quickjs", "jsc", "browser"] as const) {
    const name = `${ENGINE_BIN[engine]}/bun`;
    if (programs.has(name)) continue;
    let loading: Promise<WebAssembly.Module> | undefined;
    const module = engine === options.engine && options.adapter !== "preview1" ? options.module
      : () => loading ??= loadWasm(new URL(ENGINES[engine].wasm, location.href).href, () => {}).then(result => result.module);
    for (const command of ["bun", "node"]) {
      const path = `${ENGINE_BIN[engine]}/${command}`;
      subprocess.register(path, { module, adapter: "bun", engine });
      programs.add(path);
    }
  }
  const starting = performance.now();
  const worker = new Worker(workerUrl, { type: "module" });
  let settle: (result: RunResult) => void = () => {};
  const done = new Promise<RunResult>((resolve) => (settle = resolve));
  let finished = false;
  let confirmed = false;
  let selectedResult: RunResult | undefined;
  let outcomeTimer: ReturnType<typeof setTimeout> | null = null;
  const confirm = (ownedDisposal = false) => {
    if (confirmed || (options.runtime.disposed && !ownedDisposal)) return;
    confirmed = true;
    // The admission fence proves completion. Never make run.done depend on terminate().
    settle(selectedResult!);
    stopWorker();
    releaseRootConsumer();
  };
  const finish = (result: RunResult, acknowledged = false, signal?: number, ownedDisposal = false) => {
    // Page disposal may take ownership while this run is already awaiting its root fence.
    // Its stop hook runs after the owned fence and must settle that existing outcome too.
    if (finished) { if (ownedDisposal) confirm(true); return; }
    if (options.runtime.disposed && !ownedDisposal) return;
    if (rootOutcome) {
      const winner = claimOutcome(rootOutcome, signal === undefined
        ? { kind: "exited", code: result.code } : { kind: "signaled", code: signal });
      result = (winner.kind === "start-failed" || winner.kind === "exited" && winner.code === result.code) && result.error
        ? { code: waitStatus(winner), error: result.error } : { code: waitStatus(winner) };
    }
    if (!ownedDisposal) subprocess.revokeRuntimeProcess(rootPid);
    selectedResult = result;
    finished = true;
    if (outcomeTimer !== null) clearTimeout(outcomeTimer);
    outcomeTimer = null;
    if (acknowledged) {
      rootAcknowledged = true;
      options.runtime.filesystem.reap(request.filesystem);
    }
    const rootExit = ownedDisposal ? undefined : subprocess.rootExit(result.code);
    // Outcome/revocation is immediate; confirmation and physical stop require the filesystem
    // fence. An adopted root's exit already joins it; only a root the service never saw needs its own.
    const quiescence = acknowledged || ownedDisposal || rootExit ? undefined : quiesceRoot();
    helper?.dispose();
    if (moduleCache) void caches.delete(moduleCache);
    if (quiescence || rootExit) void Promise.all([quiescence, rootExit]).then(() => confirm())
      .catch(error => { if (!options.runtime.disposed) console.error("bun-wasm: root teardown failed", error); });
    else confirm(ownedDisposal);
  };
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
    if (options.runtime.disposed) return;
    if (finished) {
      if (msg.type === "runtime-proc") subprocess.rejectRuntimeMessage(msg);
      return;
    }
    const selected = rootOutcome && readOutcome(rootOutcome);
    if (msg.type === "cleanup-error") {
      console.error("bun-wasm: root cleanup failed", msg.message);
      finish({ code: msg.code }, false, msg.signal);
      return;
    }
    if (selected?.kind === "signaled" && msg.type !== "exit" && msg.type !== "error") {
      // Reject capabilities at the dispatch boundary too: the periodic observer need not have
      // run yet when a guest catches its own terminal unwind and sends more messages.
      if (msg.type === "runtime-proc") subprocess.rejectRuntimeMessage(msg);
      finish({ code: selected.status }, false, selected.code);
      return;
    }
    if (msg.type === "runtime-proc") {
      void subprocess.runtimeMessage(msg, rootPid).catch(error => console.error("bun-wasm: process message failed", error));
      return;
    }
    if (msg.type === "phase") {
      const duration = msg.name === "worker-start" ? performance.now() - starting : msg.duration;
      performance.measure(`bunwasm:${msg.name}`, { start: performance.now() - duration, duration });
      hooks.phase?.(msg.name, duration);
      return;
    }
    if (msg.type === "net") {
      helper?.handle(msg.req);
      return;
    }
    if (msg.type === "stdout" || msg.type === "stderr") {
      (msg.type === "stdout" ? hooks.stdout : hooks.stderr)(msg.data);
      return;
    }
    if (msg.type !== "exit" && msg.type !== "error") return;
    if (msg.cleanupErrors?.length) console.error("bun-wasm: root cleanup failed", msg.cleanupErrors);
    // Terminals want CRLF between the error's stack lines.
    if (msg.type === "error") finish({ code: msg.code, error: `bun.wasm crashed: ${msg.message}`.replace(/\r?\n/g, "\r\n") }, true);
    else finish({ code: msg.code }, true, msg.signal);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    finish({ code: 1, error: `worker error (${workerUrl}): ${event.message || (event.error instanceof Error ? event.error.message : "the browser could not load or execute the worker script")}${event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : ""}` });
  };
  let prepared = false;
  const preparation = (async () => {
      const { workerProcessState, createWorkerProcessTransport } = await import("waffle/proc/worker-client");
      const transport = request.runtimeProcess ??= createWorkerProcessTransport({ pid, job, identity: options.runtime.identities.buffer });
      const state = workerProcessState(transport);
      // The host endpoint and descriptor reservations use the same filesystem identity.
      const { port: _port, ...filesystem } = request.filesystem;
      transport.data = { ...(transport.data as object | undefined), filesystem };
    if (!await subprocess.adoptRuntimeRoot(transport, () => finished)) return;
    if (options.adapter !== "preview1" && isToolCommand(options.args)) request.module = await loadTools();
      rootOutcome = state.signals.outcome;
    rootPid = state.pid;
    rootJob = state.job;
    releaseRootConsumer();
    prepared = true;
    if (!finished) {
      worker.postMessage(request, [request.filesystem.port]);
      watchOutcome();
    }
  })().catch(error => finish({ code: 126, error: String(error) }));
  function watchOutcome(): void {
    if (!rootOutcome || finished) return;
    outcomeTimer = setTimeout(() => {
      outcomeTimer = null;
      const result = readOutcome(rootOutcome!);
      // A guest can catch a default-signal unwind and keep running. Its already selected fatal
      // outcome is authority to revoke, not an acknowledgement that filesystem locks are free.
      if (result?.kind === "signaled") finish({ code: waitStatus(result) }, false, result.code);
      else watchOutcome();
    }, 4);
  }
  let interrupted = false;
  const kill = (requestedSignal?: 2 | 9 | 15): void => {
    if (finished) return;
    if (!prepared) { void preparation.then(() => kill(requestedSignal)); return; }
    const signal = requestedSignal ?? (interrupted ? 9 : 2);
    interrupted = true;
    // The broker synchronously publishes every job member before any teardown callback. Root
    // HANDLE/IGNORE stays alive; DEFAULT selects its typed outcome without guest cooperation.
    void subprocess.killJob(rootJob, signal).catch(error => console.error("bun-wasm: job signal failed", error));
    const result = readOutcome(rootOutcome!);
    if (result) finish({ code: waitStatus(result) }, false, result.kind === "signaled" ? result.code : undefined);
  };
  return { done, kill };
}
