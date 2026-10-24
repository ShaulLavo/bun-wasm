// Bun's guest policy over Waffle's reusable process bootstrap. Importing this module has no
// side effects: the worker entry (worker.ts) wires it to a worker's message port.
import { startEngineHost } from "./engine-host.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage, WorkerExecutor } from "waffle/browser/worker";
import { NetHost } from "./net/host.js";
import { DefaultSignal } from "./default-signal.js";
import type { NetRequest } from "./net/protocol.js";
import { HOST_CALL_FD, installHostSlots, installHostSlotsViaImport } from "./net/trampoline.js";

export type Engine = "quickjs" | "jsc" | "browser";

export interface RunRequest extends RuntimeWorkerRequest {
  engine: Engine;
  adapter?: "bun" | "preview1";
  trace: boolean;
  /** The networking ring (net/ring.ts); null when the page is not cross-origin isolated. */
  net: SharedArrayBuffer | null;
  /**
   * Browser engine: the Cache Storage cache for import cycles, served by the service worker
   * under ./m/. Acyclic modules use blob URLs. Null disables import cycles.
   */
  moduleCache: string | null;
  /**
   * How the wasm engines get the host functions (`?slots=`): "imports" (default) has the guest
   * call them through a WASI import; "table" appends them to the guest's function table as
   * functions of a second module, which iOS Safari rejects at call_indirect ("signature does not
   * match"), so it is kept only for comparison; "off" installs none.
   */
  slots?: "table" | "imports" | "off";
}

export type WorkerMessage = RuntimeWorkerMessage | { type: "net"; req: NetRequest };

// The browser engine's polyfills replace globalThis.Response; Cache.put needs the real one.
const NativeResponse = Response;

/** Named module URLs for engine-host.js, stored where the service worker (sw.ts) serves them. */
function moduleStore(cacheName: string, location: { href: string }) {
  const run = cacheName.replace(/^bunwasm-m-/, "");
  const base = new URL(`./m/${run}/`, location.href).href;
  const openCache = caches.open.bind(caches, cacheName);
  let cache: Promise<Cache> | undefined;
  return {
    url: (key: string) => base + encodeURIComponent(key),
    put: async (url: string, source: string) => {
      const headers = { "content-type": "text/javascript; charset=utf-8" };
      const store = await (cache ??= openCache());
      await store.put(url, new NativeResponse(source, { headers }));
    },
  };
}

export type SleepMode = "atomics" | "busy-wait";

// The engines' default stack budgets are measured on V8, whose first wasm tier uses frames close to
// its optimized ones. JavaScriptCore starts in an interpreter with frames up to three times larger,
// in 512 KiB worker stacks on Apple platforms, so other engines get the budgets measured there
// (docs/stack-limits.md). V8 is the engine whose stack traces have "    at " frames.
const smallStackKib = (): Partial<Record<Engine, string>> | null => /\n\s+at /.test(new Error().stack ?? "")
  ? null
  : { quickjs: "32", jsc: "192" };

export interface BunExecutorHost {
  /** The worker's global scope: its location and fetch, and where network requests are posted. */
  readonly location: { href: string };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
}

/**
 * The Bun executor for one process. Spawning, pipes, waiting and signals are Waffle's: the guest
 * imports the `runtime_proc` ABI directly. This adds Bun's networking slots, the browser engine
 * host and the engine stack budgets.
 */
export function createBunExecutor(req: RunRequest, host: BunExecutorHost = globalThis as unknown as BunExecutorHost): WorkerExecutor<RunRequest> {
  let netHost: NetHost | null = null;
  const slots = req.adapter === "preview1" ? "off" : req.slots ?? "imports";
  const stackKib = smallStackKib()?.[req.engine];
  const env = stackKib && !("BUN_WASM_STACK_KIB" in req.env) ? { ...req.env, BUN_WASM_STACK_KIB: stackKib } : req.env;
  return {
    hostCallFd: HOST_CALL_FD,
    env: () => env,
    // Bun's own fatal-unwind type, which the engine interruption probes recognize.
    signalError(signal): never { throw new DefaultSignal(signal); },
    terminalSignal: error => error instanceof DefaultSignal ? error.signal : undefined,
    instantiated({ instance, wasi, fs, checkActive }) {
      netHost = req.net ? new NetHost(req.net, (net, transfer = []) => host.postMessage({ type: "net", req: net }, transfer), (path, bytes) => fs.writeFile(path, bytes), { shared: true }) : null;
      if (slots === "off") return;
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("bun-wasm has no memory");
      netHost?.attach(memory);
      if (!netHost) return;
      // A guest that caught its default-signal unwind must not keep using the network.
      const impls = Object.fromEntries(Object.entries(netHost.slots()).map(([name, call]) => [name, (...args: number[]) => { checkActive(); return call(...args); }]));
      if (slots === "imports") wasi.hostCall = installHostSlotsViaImport(instance, impls);
      else installHostSlots(instance, impls);
    },
    run({ instance, checkActive, finish, runtimeState }, exited) {
      const ready = instance.exports.bunwasm_ready as (() => number) | undefined;
      if (exited !== null || req.adapter === "preview1" || req.engine !== "browser" || ready?.() !== 1) return exited ?? 0;
      const net = slots !== "off" ? netHost?.engineNet() : undefined;
      const nativeFetch = host.fetch.bind(host);
      return startEngineHost({
        instance, moduleUrls: "blob",
        modules: req.moduleCache ? moduleStore(req.moduleCache, host.location) : undefined,
        fetch: (input, init) => { checkActive(); return nativeFetch(input, init); },
        net, processWake: runtimeState?.wake, onExit: code => finish({ code }),
      });
    },
  };
}
