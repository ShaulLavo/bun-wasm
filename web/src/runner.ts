// Running bun.wasm from a page: loading the engine's wasm, and starting one `bun …` command in a
// fresh worker with its networking (fetch, Bun.serve previews). Shared by the playground (main.ts)
// and the sandbox (../sandbox/).

import type { DirNode } from "./fs";
import { NetHelper } from "./net/helper";
import { createRing } from "./net/ring";
import { activated } from "./preview";
import { assetBuild, cachedEngine, cacheEngine, evictEngine } from "./startup-cache";
import { measureStartup } from "./startup";
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
  let res = await fetch(gzUrl);
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
  if (build) setTimeout(() => {
    const headers = { "content-type": "application/wasm", "content-length": String(size) };
    void cacheEngine(key, build, new Response(new Blob(chunks), { headers }));
  }, 0);
  return { ...engine, build };
}

// The browser engine imports program modules from named URLs served by the service worker at
// ./__bunwasm/ (sw.ts), which is what lets imports form cycles. Workers started from that scope are
// controlled by it; without it (no service workers, or registration failed) modules use blob URLs.
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
  /** The filesystem the run starts from (copied into the worker). */
  root: DirNode;
  /** From registerModuleScope(): run the worker under ./__bunwasm/. */
  moduleScope: boolean;
  trace?: boolean;
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
  /** The filesystem when the program exited; null when it was killed or the worker failed. */
  root: DirNode | null;
  /** Set when bun.wasm crashed or the worker failed to start. */
  error?: string;
}

export interface Run {
  readonly done: Promise<RunResult>;
  /** Terminates the worker (exit code 130); filesystem changes from the run are dropped. */
  kill(): void;
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
  const request: RunRequest = {
    engine: options.engine,
    module: options.module,
    args: ["bun", ...options.args],
    env: options.env,
    root: options.root,
    trace: options.trace ?? false,
    net: ring,
    moduleCache,
    slots: slotsMode(),
  };
  const workerUrl = new URL(options.moduleScope ? `${MODULE_SCOPE}worker.js` : "./worker.js", location.href).href;
  const starting = performance.now();
  const worker = new Worker(workerUrl, { type: "module" });
  let settle: (result: RunResult) => void = () => {};
  const done = new Promise<RunResult>((resolve) => (settle = resolve));
  let finished = false;
  const finish = (result: RunResult) => {
    if (finished) return;
    finished = true;
    worker.terminate();
    helper?.dispose();
    if (moduleCache) void caches.delete(moduleCache);
    settle(result);
  };
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
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
    // Terminals want CRLF between the error's stack lines.
    if (msg.type === "error") finish({ code: 134, root: msg.root, error: `bun.wasm crashed: ${msg.message}`.replace(/\r?\n/g, "\r\n") });
    else finish({ code: msg.code, root: msg.root });
  };
  worker.onerror = (event) => {
    event.preventDefault();
    finish({ code: 1, root: null, error: `worker error (${workerUrl}): ${event.message || (event.error instanceof Error ? event.error.message : "the browser could not load or execute the worker script")}${event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : ""}` });
  };
  worker.postMessage(request);
  return { done, kill: () => finish({ code: 130, root: null }) };
}
