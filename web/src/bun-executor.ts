import { adoptLinkPlan, instantiateLinkPlan, type LinkedGroup, type SharedLinkPlan } from "waffle/link";
import { programKind } from "../../src/engine-kind.js";
import { createMemoryPublisher, observeMemoryImports } from "./memory-channel.js";
import { createMemoryReader, type EngineDiagnostics, type MemorySnapshot, type MemoryTelemetryTransport } from "./memory-telemetry.js";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
// Bun's guest policy over Waffle's reusable process bootstrap. Importing this module has no
// side effects: the worker entry (worker.ts) wires it to a worker's message port.
import { startEngineHost } from "./engine-host.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage, WorkerExecutor } from "waffle/browser/worker";
import { NetHost } from "./net/host.js";
import { engineStackBudgets, jscParserReserve, type StackHost } from "./engine-stack-budget.js";
import { DefaultSignal } from "./default-signal.js";
import type { NetRequest } from "./net/protocol.js";
import { HOST_CALL_FD, installHostSlots, installHostSlotsViaImport } from "./net/trampoline.js";
import { createLookupClient, type LookupClient } from "./net/lookup.js";
import { exportSharedObjects, type SharedObjectService } from "./shared-objects/service.js";
import type { BunSharedConnection, BunSharedNativeHost } from "./shared-objects/protocol.js";
import type { BunTerminal } from "./bun-terminal.js";

import type { Engine } from "../../src/engine-kind.js";
export type { Engine } from "../../src/engine-kind.js";

export interface RunRequest extends RuntimeWorkerRequest {
  engine: Engine;
  /** Page observations unavailable on WorkerNavigator, also supplied for guest spawns. */
  stackHost?: StackHost;
  memoryTelemetry?: MemoryTelemetryTransport;
  linkPlan?: SharedLinkPlan;
  memoryLimitBytes?: number | null;
  adapter?: "bun" | "preview1";
  trace: boolean;
  /** The networking ring (net/ring.ts); null when the page is not cross-origin isolated. */
  net: SharedArrayBuffer | null;
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

export type WorkerMessage = RuntimeWorkerMessage | { type: "bun-memory"; snapshot: MemorySnapshot } | { type: "net"; req: NetRequest } | BunSharedConnection;

export type SleepMode = "atomics" | "busy-wait";

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
/** Whether a spawn carries the shell's terminal session (bun-terminal.ts), so worker.ts loads it first. */
export function hasTerminalMetadata(req: RunRequest): boolean {
  const data = req.runtimeProcess?.data;
  return typeof data === "object" && data !== null && ("terminalContext" in data || "terminalInput" in data);
}

/** bun-terminal.ts as worker.ts loaded it: only for a spawn with terminal metadata, like Waffle's own terminal module. */
export type TerminalModule = typeof import("./bun-terminal.js") | Error | undefined;
/** The nested execution host as worker.ts loaded it: only for an admitted group member. */
export type NestedModule = typeof import("./nested/host.js") | Error | undefined;

// Chromium PBL exhausts its browser-native stack at 35 reentries, below the wire's 64-entry limit.
const SPIDERMONKEY_REENTRY_LIMIT = 16;

function withDefault(env: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  return value === undefined || key in env ? env : { ...env, [key]: value };
}

/**
 * The host's stack defaults (engine-stack-budget.ts). Each key is added only when the request lacks
 * it, independently of the other: an explicit or empty value of one never changes the other's default.
 */
function stackEnvironment(req: RunRequest, stack: string, userAgent: string): Record<string, string> {
  const budgeted = withDefault(req.env, "BUN_WASM_STACK_KIB", engineStackBudgets(stack, userAgent, req.stackHost)?.[req.engine]);
  if (req.engine !== "jsc") return budgeted;
  return withDefault(budgeted, "BUN_WASM_JSC_PARSER_RESERVE", jscParserReserve(stack, userAgent, req.stackHost));
}

export function createBunExecutor(req: RunRequest, host: BunExecutorHost = globalThis as unknown as BunExecutorHost, terminalModule: TerminalModule = undefined, nestedModule: NestedModule = undefined): WorkerExecutor<RunRequest> {
  let nested: import("./nested/host.js").NestedHost | undefined;
  let groupMemory: WebAssembly.Memory | undefined;
  let netHost: NetHost | null = null;
  let sharedObjects: SharedObjectService | undefined;
  let terminal: BunTerminal | undefined;
  const slots = req.adapter === "preview1" ? "off" : req.slots ?? "imports";
  const baseEnv = stackEnvironment(req, new Error().stack ?? "", globalThis.navigator?.userAgent ?? "");
  const generation = allocationBoundaryGeneration(req);
  const env = generation === undefined ? baseEnv : { ...baseEnv, BUN_WASM_JSC_ALLOCATION_BOUNDARY_GENERATION: String(generation) };
  const lookupClient: LookupClient | undefined = req.lookupPort
    ? createLookupClient(req.lookupPort)
    : req.lookupChannel && typeof BroadcastChannel === "function"
      ? createLookupClient(new BroadcastChannel(req.lookupChannel))
      : undefined;
  const lookup = lookupClient;
  const linked = linkedExecutor(req, host, generation, group => {
    groupMemory = group.memory;
    nested?.bindCore(group.entry, group.memory);
  });
  return {
    ...linked,
    hostCallFd: HOST_CALL_FD,
    namespaces(context): WebAssembly.Imports {
      if (!req.memoryGroup) return {};
      if (!nestedModule || nestedModule instanceof Error) throw nestedModule ?? new TypeError("A group member needs the nested execution host");
      nested = new nestedModule.NestedHost(
        context.checkActive,
        text => { context.post("stderr", new TextEncoder().encode(text)); },
        req.engine === "spidermonkey" ? SPIDERMONKEY_REENTRY_LIMIT : undefined,
      );
      return { runtime_nested: nested.imports };
    },
    beforeBindings({ wasi }) {
      if (nested && nestedModule && !(nestedModule instanceof Error)) nested.bindProvider(nestedModule.regionProvider(wasi));
    },
    setup({ checkActive }) {
      terminal = attach(req, terminalModule, checkActive);
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
    async instantiated({ instance, wasi, fs, checkActive, notifications }) {
      // No guest code runs until this member holds every pre-attached buffer; a failed grant fails the start.
      if (sharedObjects) { await sharedObjects.ready; checkActive(); }
      netHost = req.net ? new NetHost(req.net, (net, transfer = []) => host.postMessage({ type: "net", req: net }, transfer), (path, bytes) => fs.writeFile(path, bytes), { shared: true }) : null;
      if (slots === "off") return;
      // The network poll is where the guest loop sleeps; Waffle's notification set lets it also
      // wake on filesystem commits, which is how fs.watch learns of a write without a timer.
      if (netHost) {
        if (!notifications) throw new Error("Bun networking requires the launcher's notificationWorkerUrl");
        const set = await notifications.arm({ network: netHost.runtime });
        checkActive();
        netHost.runtime.attachNotifications(set, () => wasi.filesystemWatches);
      }
      // A group member's PIE image imports the group memory instead of exporting one.
      const memory = instance.exports.memory ?? groupMemory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("bun-wasm has no memory");
      netHost?.attach(memory);
      if (!netHost) return;
      // A guest that caught its default-signal unwind must not keep using the network.
      const impls = Object.fromEntries(Object.entries(netHost.slots()).map(([name, call]) => [name, (...args: number[]) => { checkActive(); return call(...args); }]));
      if (slots === "imports") wasi.hostCall = installHostSlotsViaImport(instance, impls, memory);
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
      // No module store: every ES module loads as a registration record (module-records.ts),
      // with or without a service worker controlling this worker.
      return startEngineHost({
        instance, moduleUrls: "blob",
        fetch: (input, init) => { checkActive(); return nativeFetch(input, init); },
        sharedObjects, net, terminal, processWake: runtimeState?.wake, onExit: code => finish({ code }),
      });
    },
  };
}

// A start fails when its terminal module did not load; absent metadata keeps ordinary stdin.
function attach(req: RunRequest, terminalModule: TerminalModule, checkActive: () => void): BunTerminal | undefined {
  if (terminalModule instanceof Error) throw terminalModule;
  if (terminalModule) return terminalModule.attachBunTerminal(req, checkActive);
  if (hasTerminalMetadata(req)) throw new TypeError("Terminal metadata arrived without its terminal module");
  return undefined;
}

function finishHostServices(sharedObjects: SharedObjectService | undefined, lookupClient: LookupClient | undefined, lookupPort: MessagePort | undefined) {
  try { sharedObjects?.close(); }
  finally {
    try { lookupClient?.close(); }
    finally { lookupPort?.close(); }
  }
}

// An armed JSC instance gets a fresh random generation in 1..2^53-1 that its VM must acknowledge
// in the boundary record; a value inherited from a parent process is replaced, never reused.
function allocationBoundaryGeneration(req: RunRequest): number | undefined {
  if (req.engine !== "jsc" || req.env.BUN_WASM_JSC_ALLOCATION_BOUNDARY !== "1") return undefined;
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return (high & 0x1fffff) * 2 ** 32 + low || allocationBoundaryGeneration(req);
}

// The allocation-boundary reader is a separate chunk, fetched only for an armed JSC process.
async function engineDiagnostics(generation: number | undefined): Promise<EngineDiagnostics | undefined> {
  if (generation === undefined) return undefined;
  return (await import("./jsc-allocation-boundary.js")).allocationBoundaryDiagnostics(generation);
}

function linkedExecutor(req: RunRequest, host: BunExecutorHost, generation: number | undefined, onLinked: (group: LinkedGroup) => void): Pick<WorkerExecutor<RunRequest>, "instantiate" | "initialize" | "beforeFinish"> {
  if (!req.linkPlan) return {};
  const request = { ...req, linkPlan: req.linkPlan };
  const limitBytes = req.memoryLimitBytes ?? null;
  let group: LinkedGroup | undefined;
  let reader: ReturnType<typeof createMemoryReader> | undefined;
  let publisher: ReturnType<typeof createMemoryPublisher> | undefined;
  let diagnostics: EngineDiagnostics | undefined;
  let finished = false;
  let checkStack: (() => void) | undefined;
  return {
    async instantiate(imports, context) {
      context.checkActive();
      if (finished || group) throw new Error("link executor already used");
      diagnostics = await engineDiagnostics(generation);
      const plan = adoptLinkPlan(request.linkPlan);
      const declared = programKind(plan.entryModule);
      const requireSelected = declared === "spidermonkey" || req.adapter !== "preview1" && req.engine !== "browser";
      if (requireSelected && declared !== req.engine) throw new TypeError(`Selected ${req.engine} engine differs from paired core declaration`);
      if (declared === "spidermonkey" && req.memoryGroup) checkStack = spiderMonkeyGroupStack(imports, req.memoryGroup.stackBytes);
      context.checkActive();
      if (finished) throw new Error("link executor finished during admission");
      const capture = (normal: boolean, force: boolean) => { if (normal) context.checkActive(); publisher?.capture(normal, force); };
      const linked = instantiateLinkPlan(plan, { wasi: context.wasi,
        coreImports: observeMemoryImports(imports, capture, false), checkActive: context.checkActive, bindMemory: context.bindMemory });
      group = linked;
      onLinked(linked);
      reader = createMemoryReader(req.engine, linked.entry, undefined, limitBytes, req.memoryTelemetry, undefined, linked.entry.exports.memory ?? linked.memory);
      if (req.memoryTelemetry) publisher = createMemoryPublisher(req.memoryTelemetry.buffer, reader);
      context.checkActive();
      return linked.entry;
    },
    initialize(context) {
      context.checkActive();
      if (!group || finished) throw new Error("link group is unavailable");
      const capture = (normal: boolean, force: boolean) => { if (normal) context.checkActive(); publisher?.capture(normal, force); };
      checkStack?.();
      const originalImports = context.wasi.imports;
      context.wasi.imports = (module, bindings) => observeMemoryImports(originalImports.call(context.wasi, module, bindings), capture, true);
      try { group.initialize(); checkStack?.(); }
      finally { context.wasi.imports = originalImports; }
      reader = createMemoryReader(req.engine, group.entry, group.libraries.find(library => library.id === req.engine)?.instance, limitBytes, req.memoryTelemetry, diagnostics, group.entry.exports.memory ?? group.memory);
      if (req.memoryTelemetry) publisher = createMemoryPublisher(req.memoryTelemetry.buffer, reader);
    },
    beforeFinish() {
      if (finished) return;
      finished = true;
      const owned = group;
      group = undefined;
      try {
        const snapshot = publisher ? publisher.finish() : reader?.finish();
        if (snapshot) host.postMessage({ type: "bun-memory", snapshot });
      } finally {
        publisher = undefined;
        reader = undefined;
        owned?.dispose();
      }
    },
  };
}

/** The side derives its bounds from a top-level initializer's stack, not linker symbols. */
function spiderMonkeyGroupStack(imports: WebAssembly.Imports, stackBytes: number): () => void {
  const pointer = imports.env?.__stack_pointer;
  const low = imports["GOT.mem"]?.__stack_low;
  const high = imports["GOT.mem"]?.__stack_high;
  const memory = imports.env?.memory;
  if (!(pointer instanceof WebAssembly.Global) || !(low instanceof WebAssembly.Global) || !(high instanceof WebAssembly.Global) || !(memory instanceof WebAssembly.Memory))
    throw new TypeError("SpiderMonkey group stack requires the host's carved globals and memory");
  const bottom = Number(low.value) >>> 0;
  const top = Number(high.value) >>> 0;
  if (stackBytes !== BUN_MEMORY_GROUP_POLICY.stackBytes || top - bottom !== BUN_MEMORY_GROUP_POLICY.stackBytes || top % 65536 || bottom % 65536 || top > memory.buffer.byteLength)
    throw new RangeError("SpiderMonkey group stack must be an exact page-aligned 8 MiB carve");
  const balanced = () => {
    if ((Number(pointer.value) >>> 0) !== top || (Number(low.value) >>> 0) !== bottom || (Number(high.value) >>> 0) !== top)
      throw new RangeError("SpiderMonkey group stack pointer was not restored to the carved top");
  };
  balanced();
  return balanced;
}
