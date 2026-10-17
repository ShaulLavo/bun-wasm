// Running bun.wasm from a page: loading the engine's wasm, and starting one `bun …` command in a
// fresh worker with its networking (fetch, Bun.serve previews). Shared by the playground (main.ts)
// and the sandbox (../sandbox/).

import type { SharedFilesystem } from "./shared-fs";
import { NetHelper } from "./net/helper";
import { createRing } from "./net/ring";
import { activated } from "./preview";
import { assetBuild, cachedEngine, cacheEngine, evictEngine } from "./startup-cache";
import { measureStartup } from "./startup";
import { SubprocessBroker } from "./subprocess-broker";
import { createSignalState } from "../../runtime/proc/signals";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import type { Engine, RunRequest, WorkerMessage } from "./worker";

export type { Engine } from "./worker";

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

/**
 * Fetches and compiles a wasm module. Sites ship it gzipped (static hosts cap file sizes, and it is
 * 3-4x smaller) and the page decompresses it; a plain .wasm URL works too. Throws WasmMissing on 404.
 */
export async function loadWasm(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string | null }> {
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
  filesystem: SharedFilesystem;
  /** From registerModuleScope(): run the worker under ./__bunwasm/. */
  moduleScope: boolean;
  trace?: boolean;
  /** Skip Bun host slots for arbitrary Preview1 guests. */
  adapter?: RunRequest["adapter"];
  /** Explicit generic ownership transport; extended runtime_proc imports activate one automatically. */
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
  kill(signal?: 2 | 9): void;
}

/** `?slots=table|off` on the page: how the wasm engines get networking (see RunRequest.slots). */
function slotsMode(): RunRequest["slots"] {
  const value = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("slots");
  return value === "table" || value === "off" ? value : "imports";
}

/** Starts `bun <args>` in a fresh worker. Networking needs a cross-origin isolated page. */
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
  const isolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
  const generic = !!options.runtimeProcess || WebAssembly.Module.imports(options.module).some(entry =>
    entry.module === "runtime_proc" && !["signal", "interrupted", "default_signal"].includes(entry.name));
  const filesystemIdentity = (options.runtimeProcess?.data as { filesystem?: import("../../runtime/fs").FilesystemIdentity } | undefined)?.filesystem;
  const request: RunRequest = {
    engine: options.engine,
    adapter: options.adapter,
    runtimeProcess: options.runtimeProcess,
    module: options.module,
    args: ["bun", ...options.args],
    env: options.env,
    filesystem: filesystemIdentity ? options.filesystem.connect(filesystemIdentity) : options.filesystem.fork(),
    trace: options.trace ?? false,
    net: ring,
    moduleCache,
    slots: slotsMode(),
    spawnBroker: true,
    pid: 1,
    jobId: 1,
    interrupt: isolated && !generic ? new SharedArrayBuffer(4) : undefined,
    requestedSignal: isolated && !generic ? new SharedArrayBuffer(4) : undefined,
    signalState: isolated && !generic ? createSignalState().buffer as SharedArrayBuffer : undefined,
    outcome: isolated && !generic ? new SharedArrayBuffer(8) : undefined,
  };
  let rootOutcome = request.outcome ? outcomeWord(request.outcome) : null;
  let rootPid = 1, rootJob = 1;
  const workerUrl = new URL(options.moduleScope ? `${MODULE_SCOPE}worker.js` : "./worker.js", location.href).href;
  const subprocess = new SubprocessBroker(workerUrl, options.filesystem, { output: (fd, data) => (fd === 2 ? hooks.stderr : hooks.stdout)(data), root: isolated && !generic ? {
    pid: 1, job: 1, interrupt: request.interrupt, requestedSignal: request.requestedSignal,
    signalState: request.signalState, outcome: request.outcome,
  } : undefined });
  // Generic aliases use the page/root engine; named executables select an engine explicitly.
  const modules = new Map<Engine, Promise<WebAssembly.Module>>();
  modules.set(options.engine, Promise.resolve(options.module));
  const moduleFor = (engine: Engine) => () => {
    let module = modules.get(engine);
    if (!module) {
      module = loadWasm(new URL(ENGINES[engine].wasm, location.href).href, () => {}).then(result => result.module);
      modules.set(engine, module);
    }
    return module;
  };
  const rootExecutable = options.adapter === "preview1"
    ? { module: moduleFor(options.engine), adapter: "preview1" as const, cooperative: true as const }
    : { module: moduleFor(options.engine), adapter: "bun" as const, engine: options.engine };
  for (const name of ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"]) subprocess.register(name, rootExecutable);
  for (const engine of ["quickjs", "jsc", "browser"] as const) subprocess.register(`bun-${engine}`, { module: moduleFor(engine), adapter: "bun", engine });
  const starting = performance.now();
  const worker = new Worker(workerUrl, { type: "module" });
  let settle: (result: RunResult) => void = () => {};
  const done = new Promise<RunResult>((resolve) => (settle = resolve));
  let finished = false;
  let outcomeTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (result: RunResult, acknowledged = false, signal?: number) => {
    if (finished) return;
    if (rootOutcome) {
      const winner = claimOutcome(rootOutcome, signal === undefined
        ? { kind: "exited", code: result.code } : { kind: "signaled", code: signal });
      result = winner.kind === "exited" && winner.code === result.code && result.error
        ? { code: winner.status, error: result.error } : { code: winner.status };
    }
    subprocess.revokeRuntimeProcess(rootPid);
    finished = true;
    if (outcomeTimer !== null) clearTimeout(outcomeTimer);
    outcomeTimer = null;
    if (acknowledged) {
      options.filesystem.reap(request.filesystem);
      worker.terminate();
    } else {
      // Logical exit/revocation is immediate; physical termination must not strand a host lock.
      void options.filesystem.quiesce(request.filesystem).then(() => worker.terminate());
    }
    subprocess.rootExit(result.code);
    helper?.dispose();
    if (moduleCache) void caches.delete(moduleCache);
    settle(result);
  };
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
    if (finished) {
      if (msg.type === "spawn") subprocess.rejectSpawn(msg.request);
      if (msg.type === "runtime-proc") subprocess.rejectRuntimeMessage(msg);
      return;
    }
    const selected = rootOutcome && readOutcome(rootOutcome);
    if (selected?.kind === "signaled" && msg.type !== "exit" && msg.type !== "error") {
      // Reject capabilities at the dispatch boundary too: the periodic observer need not have
      // run yet when a guest catches its own terminal unwind and sends more messages.
      if (msg.type === "spawn") subprocess.rejectSpawn(msg.request);
      if (msg.type === "runtime-proc") subprocess.rejectRuntimeMessage(msg);
      finish({ code: selected.status }, false, selected.code);
      return;
    }
    if (msg.type === "runtime-proc") {
      void subprocess.runtimeMessage(msg, rootPid).catch(error => console.error("bun-wasm: process message failed", error));
      return;
    }
    if (msg.type === "spawn") {
      subprocess.spawn(msg.request);
      return;
    }
    if (msg.type === "child-close") {
      subprocess.close(msg.parentPid, msg.pid);
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
    if (msg.type === "default-signal") {
      // This is fatal selection, not proof that a caught unwind released filesystem locks.
      finish({ code: 128 + msg.signal }, false, msg.signal);
      return;
    }
    // Terminals want CRLF between the error's stack lines.
    if (msg.type === "error") finish({ code: msg.code, error: `bun.wasm crashed: ${msg.message}`.replace(/\r?\n/g, "\r\n") }, true);
    else finish({ code: msg.code }, true, msg.signal);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    finish({ code: 1, error: `worker error (${workerUrl}): ${event.message || (event.error instanceof Error ? event.error.message : "the browser could not load or execute the worker script")}${event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : ""}` });
  };
  let prepared = !generic;
  const preparation = generic ? (async () => {
    const { workerProcessState, createWorkerProcessTransport } = await import("../../runtime/proc/worker-client");
    const transport = request.runtimeProcess ??= createWorkerProcessTransport();
    const state = workerProcessState(transport);
    // The host endpoint and descriptor reservations use the same filesystem identity.
    const { port, ...filesystem } = request.filesystem;
    transport.data = { ...(transport.data as object | undefined), filesystem };
    await subprocess.adoptRuntimeRoot(transport);
    rootOutcome = state.signals.outcome;
    rootPid = request.pid = state.pid;
    rootJob = request.jobId = state.job;
    prepared = true;
    if (!finished) {
      worker.postMessage(request, [request.filesystem.port]);
      watchOutcome();
    }
  })().catch(error => finish({ code: 126, error: String(error) })) : undefined;
  if (!preparation) worker.postMessage(request, [request.filesystem.port]);
  function watchOutcome(): void {
    if (!rootOutcome || finished) return;
    outcomeTimer = setTimeout(() => {
      outcomeTimer = null;
      const result = readOutcome(rootOutcome!);
      // A guest can catch a default-signal unwind and keep running. Its already selected fatal
      // outcome is authority to revoke, not an acknowledgement that filesystem locks are free.
      if (result?.kind === "signaled") finish({ code: result.status }, false, result.code);
      else watchOutcome();
    }, 4);
  }
  watchOutcome();
  let interrupted = false;
  const kill = (requestedSignal?: 2 | 9): void => {
    if (finished) return;
    if (!prepared) { void preparation!.then(() => kill(requestedSignal)); return; }
    const signal = requestedSignal ?? (interrupted ? 9 : 2);
    interrupted = true;
    // Without isolation there is no shared interrupt channel or subprocess service.
    if (!request.interrupt && !request.runtimeProcess) { finish({ code: 128 + signal }, false, signal); return; }
    // The broker synchronously publishes every job member before any teardown callback. Root
    // HANDLE/IGNORE stays alive; DEFAULT selects its typed outcome without guest cooperation.
    void subprocess.killJob(rootJob, signal).catch(error => console.error("bun-wasm: job signal failed", error));
    const result = readOutcome(rootOutcome!);
    if (result) finish({ code: result.status }, false, result.kind === "signaled" ? result.code : undefined);
  };
  return { done, kill };
}
