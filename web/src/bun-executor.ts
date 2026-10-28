import { linkedWorkerHooks, type LinkPlanSource } from "waffle/link";
// Bun's guest policy over Waffle's reusable process bootstrap. Importing this module has no
// side effects: the worker entry (worker.ts) wires it to a worker's message port.
import { startEngineHost } from "./engine-host.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage, WorkerExecutor } from "waffle/browser/worker";
import { NetHost } from "./net/host.js";
import { DefaultSignal } from "./default-signal.js";
import type { NetRequest } from "./net/protocol.js";
import { HOST_CALL_FD, installHostSlots, installHostSlotsViaImport } from "./net/trampoline.js";
import { createLookupClient, type LookupClient } from "./net/lookup.js";
import { exportSharedObjects, type SharedObjectService } from "./shared-objects/service.js";
import type { BunSharedConnection, BunSharedNativeHost } from "./shared-objects/protocol.js";
import { attachBunTerminal, type BunTerminal } from "./bun-terminal.js";

export type Engine = "quickjs" | "jsc" | "browser" | "hermes";

export interface RunRequest extends RuntimeWorkerRequest {
  engine: Engine;
  linkPlan?: LinkPlanSource;
  adapter?: "bun" | "preview1";
  trace: boolean;
  /** The networking ring (net/ring.ts); null when the page is not cross-origin isolated. */
  net: SharedArrayBuffer | null;
  /**
   * Browser engine: the Cache Storage cache for import cycles, served by the service worker
   * under ./m/. Acyclic modules use blob URLs. Null disables import cycles.
   */
  moduleCache: string | null;
  /** Bun-owned DNS lookup requests are served by the page runtime. */
  lookupPort?: MessagePort;
  /** Browser-engine DNS lookup channel name used by adapter-launched workers. */
  lookupChannel?: string;
  /** Private native route only. Guest codec installation/startup hydration is separate. */
  sharedObjects?: { readonly owner: string };
  /**
   * How the wasm engines get the host functions (`?slots=`): "imports" (default) has the guest
   * call them through a WASI import; "table" appends them to the guest's function table as
   * functions of a second module, which iOS Safari rejects at call_indirect ("signature does not
   * match"), so it is kept only for comparison; "off" installs none.
   */
  slots?: "table" | "imports" | "off";
}

export type WorkerMessage = RuntimeWorkerMessage | { type: "net"; req: NetRequest } | BunSharedConnection;

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

export interface BunExecutorHost extends BunSharedNativeHost {
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
  let sharedObjects: SharedObjectService | undefined;
  let terminal: BunTerminal | undefined;
  const slots = req.adapter === "preview1" ? "off" : req.slots ?? "imports";
  const stackKib = smallStackKib()?.[req.engine];
  const env = stackKib && !("BUN_WASM_STACK_KIB" in req.env) ? { ...req.env, BUN_WASM_STACK_KIB: stackKib } : req.env;
  const lookupClient: LookupClient | undefined = req.lookupPort
    ? createLookupClient(req.lookupPort)
    : req.lookupChannel && typeof BroadcastChannel === "function"
      ? createLookupClient(new BroadcastChannel(req.lookupChannel))
      : undefined;
  const lookup = lookupClient;
  const linked = linkedExecutor(req);
  return {
    ...linked,
    hostCallFd: HOST_CALL_FD,
    setup({ checkActive }) {
      terminal = attachBunTerminal(req, checkActive);
      if (!req.sharedObjects) return;
      if (req.engine !== "browser" || req.adapter === "preview1") throw new TypeError("Shared objects require the browser Bun engine");
      if (sharedObjects) throw new Error("Shared-object setup already completed");
      checkActive();
      sharedObjects = exportSharedObjects(req.sharedObjects.owner, host);
      try { checkActive(); }
      catch (error) { sharedObjects.close(); throw error; }
    },
    env: () => env,
    resolveTerminal: target => terminal?.resolve(target),
    spawnData: () => terminal?.spawnData() ?? {},
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
    beforeFinish() {
      try { linked.beforeFinish?.(); }
      finally {
        try { terminal?.dispose(); }
        finally { finishHostServices(sharedObjects, lookupClient, req.lookupPort); }
      }
    },
    run({ instance, checkActive, finish, runtimeState }, exited) {
      const ready = instance.exports.bunwasm_ready as (() => number) | undefined;
      if (exited !== null || req.adapter === "preview1" || req.engine !== "browser" || ready?.() !== 1) return exited ?? 0;
      if (req.sharedObjects && !sharedObjects) throw new Error("Shared-object setup did not complete");
      const net = slots !== "off" ? netHost?.engineNet(lookup) ?? (lookup ? {
        natives: { hostLookup: lookup },
        caps: {},
        onNews() {},
      } : undefined) : undefined;
      const nativeFetch = host.fetch.bind(host);
      return startEngineHost({
        instance, moduleUrls: "blob",
        modules: req.moduleCache ? moduleStore(req.moduleCache, host.location) : undefined,
        fetch: (input, init) => { checkActive(); return nativeFetch(input, init); },
        sharedObjects, net, processWake: runtimeState?.wake, onExit: code => finish({ code }),
      });
    },
  };
}

function finishHostServices(sharedObjects: SharedObjectService | undefined, lookupClient: LookupClient | undefined, lookupPort: MessagePort | undefined) {
  try { sharedObjects?.close(); }
  finally {
    try { lookupClient?.close(); }
    finally { lookupPort?.close(); }
  }
}

function linkedExecutor(req: RunRequest): Pick<WorkerExecutor<RunRequest>, "instantiate" | "initialize" | "beforeFinish"> {
  if (!req.linkPlan) return {};
  const request = { ...req, linkPlan: req.linkPlan };
  const hooks = linkedWorkerHooks();
  return {
    instantiate(imports, context) {
      if (!hooks.instantiate) throw new Error("linked worker instantiate hook is missing");
      return hooks.instantiate(imports, { ...context, request });
    },
    initialize(context) { hooks.initialize?.({ ...context, request }); },
    beforeFinish: hooks.beforeFinish,
  };
}
