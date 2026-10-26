import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../../web/src/buffer-transfer";
import { bindSharedObjectHost } from "../../../web/src/shared-objects/host";
import type { SharedObjectService } from "../../../web/src/shared-objects/service";
import type { Graph } from "./runtime-types";
import type { SourcePort } from "./source-runtime";

interface Threads {
  readonly workerData: unknown;
  readonly parentPort: SourcePort | null;
  getEnvironmentData(key: unknown): unknown;
  initialize(): void;
  receiveMessageOnPort(port: unknown): { message: unknown } | undefined;
  MessageChannel: new() => { port1: SourcePort; port2: SourcePort };
}
interface StartupInternal extends Pick<BunWasm.Internal, "sharedObjects" | "workerStartup" | "workerErrorData" | "clonePorts"> {
  runMain(path: string): void;
  require(name: "worker_threads"): Threads;
}
const runtimeRoot = new URL("../../../crates/bunwasm-runtime/src/js/", import.meta.url);
const engineSource = readFileSync(new URL("../../../web/src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export function startEngineHost", "function startEngineHost");
const EngineHost = runInNewContext(engineSource.concat("\nEngineHost;"), {
  TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask,
  SLOT_NAMES: [], bindSharedObjectHost, isWasmMemoryBuffer, transferArrayBuffers, installHostCrypto() {},
});
export function startupRuntime(options: { service?: SharedObjectService; graph: Graph; execArgv?: string[]; preload?(path: string): void }) {
  const frames: unknown[] = [], exits: number[] = [], failures: unknown[] = [], entries: unknown[] = [];
  const preloads: string[] = [], wakeups: number[] = [];
  let closes = 0;
  const execArgv: string[] = [];
  const process = { env: {
    BUNWASM_WORKER_INIT: JSON.stringify({ route: [0], envGroup: "startup", argv: ["bun", "/entry.ts"], execArgv: options.execArgv ?? [], graph: options.graph }),
    BUNWASM_WORKER_CONTROL: '{"input":3,"output":4}',
  }, execArgv, execPath: "bun", cwd: () => "/" };
  const context = createContext({
    EventTarget, Event, MessageEvent, DOMException, URL, TextEncoder, TextDecoder, Blob,
    SharedArrayBuffer, ArrayBuffer, Uint8Array, Int32Array, DataView,
  });
  const channel = { send(frame: unknown) { frames.push(frame); }, drain() {}, pump() { return false; },
    subscriptions: () => new Uint8Array(), close() { closes++; }, pending: false, ended: false };
  const modules: Record<string, unknown> = {
    process, events: EventEmitter, structured_clone: { structuredClone }, net: {},
    web: () => {}, crypto: () => {}, console: {}, bun: {},
    worker_channel: { open: () => channel },
  };
  const empty = new Set(["stack_trace", "exit_provenance", "loop_scheduler", "builtins", "bun_builtin_globals", "function", "fake_timers"]);
  const native = {
    mainPath: () => "/entry.ts", now: () => performance.now(), getAsyncContext() {}, setAsyncContext() {},
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
    base64Decode: (text: string) => new Uint8Array(Buffer.from(text, "base64")),
    transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
    closeAllDirs() {}, mapPosition() { return null; },
    writeStderr(text: string) { failures.push(text); },
    loadPolyfill(name: string) {
      if (name in modules) return () => modules[name];
      if (empty.has(name)) return () => ({});
      if (name !== "worker_threads" && name !== "worker_codec") throw new Error(`Unexpected startup module ${name}`);
      const source = readFileSync(new URL(`${name}.ts`, runtimeRoot), "utf8");
      return runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`), context);
    },
  };
  const bootstrap = runInContext(readFileSync(new URL("bootstrap.js", runtimeRoot), "utf8"), context);
  const done = Promise.withResolvers<number>();
  let internal: StartupInternal | undefined;
  const host = Object.assign(Object.create(EngineHost.prototype), {
    o: { sharedObjects: options.service, onExit(code: number) { exits.push(code); } },
    exited: false, pendingAsync: 0, timer: null,
    wasm: { describe: () => ({ entry: { kind: "run", main: "/entry.ts" } }) },
    buildNative(this: { valueNatives(): object }) { return Object.assign(this.valueNatives(), native); },
    evalPolyfill() { return bootstrapInternal; },
    installGlobals() {}, wrapPromiseJobs() {}, watchRejections() {}, flush() {},
    schedule(delay: number) { wakeups.push(delay); },
    uncaught(this: { exit(code: number): void }, error: unknown) { failures.push(error); this.exit(1); },
    resolveDone: done.resolve,
  });
  function bootstrapInternal(binding: object) {
    internal = bootstrap(binding);
    if (!internal) throw new Error("Missing bootstrap internal");
    internal.runMain = () => entries.push(internal?.require("worker_threads").workerData);
    return internal;
  }
  function loadPreload(path: string) { preloads.push(path); options.preload?.(path); }
  function preloadBuiltin() { return { createRequire: () => loadPreload }; }
  function workerFactory(value: { addIoWaiter: () => void; builtin: () => unknown }) {
    value.addIoWaiter = () => {};
    value.builtin = preloadBuiltin;
    return load("worker_threads")(value);
  }
  const load = native.loadPolyfill;
  native.loadPolyfill = name => name === "worker_threads" ? workerFactory : load(name);
  return { host, done: done.promise, frames, exits, failures, entries, preloads, wakeups, process,
    get internal() { if (!internal) throw new Error("Startup did not finish constructing internal"); return internal; },
    get closes() { return closes; },
  };
}
