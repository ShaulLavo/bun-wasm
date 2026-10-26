// Headless Node fixture host. Guests always execute in workers; the main thread owns the
// responsive Waffle process supervisor, descriptor transfers, and shared-pipe relays.
import { writeSync } from "node:fs";
import { registerHooks } from "node:module";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { posix, resolve } from "node:path";
import { WASI } from "node:wasi";
import { Worker, isMainThread, parentPort, workerData, type ResourceLimits } from "node:worker_threads";
import { workerProcessState, wakeWorkerProcess, type WorkerProcessTransport } from "waffle/proc/worker-client";
import type { PipePublicationRegistryHandle } from "waffle/proc/pipes";
import type { SpawnRequest } from "waffle/proc/types";
import { claimOutcome, markStarted } from "waffle/proc/outcome";
import { ExecutableFormatError, startFailure } from "waffle/proc";
import { installCliFetch } from "./node-install-net.mjs";
import { nodeModule, NodeProcessBroker, validateNodeCwd } from "./node-spawn.ts";
import { createNodeSignalController } from "./node-signals.ts";
import { createNodeProcess, type NodeWasiImports } from "./node-process.ts";
import { loadNodeProgram, linkNodeProgram, startNodeProgram } from "./node-linked.ts";
import type { LinkPlanSource, LinkedGroup } from "waffle/link";

const STACK_MB = 32, GUEST_STACK_KIB = "6144";
// The guest replaces globalThis.process; retain the actual native exit capability.
const nodeProcess = process;
interface Settings {
  wasmPath: string;
  engines: Partial<Record<"quickjs" | "jsc", string>>;
  stackMb: number;
  withNet: boolean;
  preopens: Record<string, string>;
  env: Record<string, string>;
  args: string[];
}
interface GuestData {
  module: WebAssembly.Module;
  linkPlan?: LinkPlanSource;
  settings: Settings;
  transport: WorkerProcessTransport;
  request?: SpawnRequest;
}
function settings(): Settings {
  const argv = nodeProcess.argv.slice(2);
  const result: Settings = { wasmPath: resolve(import.meta.dirname, "../../dist/bun-browser.wasm"), engines: {}, stackMb: STACK_MB, withNet: false, preopens: {}, env: {}, args: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { i++; break; }
    if (arg === "--wasm") result.wasmPath = argv[++i]!;
    else if (arg === "--engine") {
      const value = argv[++i] ?? "", equal = value.indexOf("="), engine = value.slice(0, equal);
      if ((engine !== "quickjs" && engine !== "jsc") || equal < 0 || !value.slice(equal + 1)) throw new Error("--engine requires quickjs=PATH or jsc=PATH");
      result.engines[engine] = resolve(value.slice(equal + 1));
    }
    else if (arg === "--net") result.withNet = true;
    else if (arg === "--stack-mb") result.stackMb = Number(argv[++i]);
    else if (arg === "--dir") {
      const [host, guest = host] = argv[++i]!.split("::");
      result.preopens[guest!] = host!;
    } else if (arg === "--env") {
      const kv = argv[++i]!, eq = kv.indexOf("=");
      result.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else break;
  }
  result.args = argv.slice(i);
  if (!Object.keys(result.preopens).length) {
    result.preopens[nodeProcess.cwd()] = nodeProcess.cwd();
    result.env.PWD ??= nodeProcess.cwd();
  }
  result.env.BUN_WASM_STACK_KIB ??= GUEST_STACK_KIB;
  return result;
}

async function main() {
  const config = settings();
  const base = await loadNodeProgram(config.wasmPath);
  const baseModule = base.module;
  const programs = new Map<WebAssembly.Module, LinkPlanSource>();
  if (base.linkPlan) programs.set(baseModule, base.linkPlan);
  const module = await nodeModule({ args: config.args, baseModule, wasmPath: config.wasmPath });
  const engines: Partial<Record<"quickjs" | "jsc", WebAssembly.Module>> = {};
  for (const engine of ["quickjs", "jsc"] as const) {
    const path = config.engines[engine];
    if (!path) continue;
    const program = await loadNodeProgram(path);
    engines[engine] = program.module;
    if (program.linkPlan) programs.set(program.module, program.linkPlan);
  }
  const broker = new NodeProcessBroker({ module: baseModule, engines, preopens: config.preopens,
    launch(context, transport) {
      validateNodeCwd(config.preopens, context.request.cwd);
      return launch({ module: context.module, settings: config, transport, request: context.request });
    },
    onError(error) { writeSync(2, `node-host: ${error instanceof Error ? error.stack : error}\n`); },
  });
  try {
    config.preopens = broker.preopens;
    config.env.PATH ??= "/bin:/usr/bin";
    broker.pipeStdin();
    const signals = createNodeSignalController(workerProcessState(broker.root).signals);
    const guest = launch({ module, settings: config, transport: broker.root });
    broker.attach(guest, broker.root);
    guest.on("exit", code => {
      const selected = signals.finish(code);
      void broker.dispose().then(() => nodeProcess.exit(selected.kind === "start-failed" ? selected.error === "ENOENT" ? 127 : 126 : selected.status));
    });
    for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGPIPE", 13]] as const) nodeProcess.on(name, () => {
      const result = signals.request(number);
      wakeWorkerProcess(broker.root);
      if (result.action === "default") {
        broker.supervisor.defaultSignal(1, number);
        void guest.terminate();
      }
    });
  } catch (error) { await broker.dispose(); throw error; }
  function launch(data: GuestData): Worker {
    const limits = (data.transport.data as { worker?: { resourceLimits?: ResourceLimits } } | undefined)?.worker?.resourceLimits;
    return new Worker(new URL(import.meta.url), { workerData: { ...data, linkPlan: programs.get(data.module) },
      resourceLimits: { maxOldGenerationSizeMb: 128, ...limits, stackSizeMb: Math.max(config.stackMb, limits?.stackSizeMb ?? 0) } });
  }
}

async function run(data: GuestData) {
  const config = data.settings;
  const request = data.request;
  const args = request ? request.argv.slice(1) : config.args;
  const env: Record<string, string> = request ? { ...request.env, PWD: request.cwd, BUN_WASM_STACK_KIB: request.env.BUN_WASM_STACK_KIB ?? GUEST_STACK_KIB } : { ...config.env };
  // This worker is created only after the registry walked the original executable path.
  env.BUNWASM_EXEC_PATH = request ? posix.resolve(request.cwd, request.executable) : "/bin/bun";
  const state = workerProcessState(data.transport);
  const signals = createNodeSignalController(state.signals);
  let cliFetch: ReturnType<typeof installCliFetch> | undefined;
  let processHost: ReturnType<typeof createNodeProcess> | undefined;
  let linked: LinkedGroup | undefined;
  function finish(code: number, signal?: number): never {
    const selected = signals.finish(code, signal);
    linked?.dispose();
    cliFetch?.dispose();
    if (processHost) {
      if (selected.kind === "signaled") processHost.client.defaultSignal(processHost.client.pid, selected.code);
      else processHost.client.exit(selected.code);
      processHost.dispose();
    }
    return nodeProcess.exit(selected.kind === "start-failed" ? selected.error === "ENOENT" ? 127 : 126 : selected.status) as never;
  }
  let entered = false;
  try {
    processHost = createNodeProcess({
      transport: data.transport, env, preopenCount: Object.keys(config.preopens).length,
      registry: (data.transport.data as { registry?: PipePublicationRegistryHandle } | undefined)?.registry,
      isSignalPending: () => signals.pending(),
      postMessage: message => parentPort!.postMessage(message), finish,
    });
    const wasi = new WASI({ version: "preview1", args: request?.argv ?? ["bun"].concat(args), env: processHost.env, preopens: config.preopens, returnOnExit: true });
    const imports = wasi.getImportObject() as NodeWasiImports;
    let instance: WebAssembly.Instance;
    if (config.withNet) cliFetch = installCliFetch(imports, () => instance, processHost.client.wake);
    const host = processHost.install(imports, () => instance, cliFetch?.call);
    const module = request ? await nodeModule({ args, baseModule: data.module, wasmPath: config.wasmPath }) : data.module;
    if (data.linkPlan && module === data.module) linked = await linkNodeProgram(data.linkPlan, imports);
    instance = linked?.entry ?? await WebAssembly.instantiate(module, imports);
    cliFetch?.install();
    host.installSlots();
    if (typeof instance.exports._start !== "function" || !(instance.exports.memory instanceof WebAssembly.Memory)) {
      throw new ExecutableFormatError("preview1 program must export memory and _start");
    }
    // Node WASI has no entry callback. Its own memory checks are covered above; all host
    // setup is complete. Entry and terminal selection arbitrate on the shared outcome word.
    if (!markStarted(state.signals.outcome)) finish(1);
    entered = true;
    const code = startNodeProgram(wasi, instance, linked);
    const ready = instance.exports.bunwasm_ready;
    if (typeof ready !== "function" || ready() !== 1) finish(code);
    // Force undici's lazy initialization before guest polyfills replace its input globals.
    await globalThis.fetch("data:,").catch(() => {});
    const nodeFetch = globalThis.fetch.bind(globalThis);
    const prefix = "bunwasm:/m/", sources = new Map<string, string>();
    registerHooks({
      resolve: (specifier, context, next) => specifier.startsWith(prefix) ? { url: specifier, shortCircuit: true } : next(specifier, context),
      load: (url, context, next) => url.startsWith(prefix) ? { format: "module", source: sources.get(url)!, shortCircuit: true } : next(url, context),
    });
    const modules = { url: (key: string) => prefix + encodeURIComponent(key), put: (url: string, source: string) => void sources.set(url, source) };
    const { createNodeNet } = await import("./node-net.mjs");
    const { startEngineHost } = await import("../src/engine-host.js");
    await startEngineHost({ instance, moduleUrls: "data", modules, fetch: nodeFetch,
      net: processHost.engineNet(config.withNet ? createNodeNet({ net, http, https, zlib }) : undefined),
      processWake: processHost.client.wake,
      onExit: finish,
    });
  } catch (error) {
    const result = entered ? { kind: "exited" as const, code: 1 } : startFailure(error);
    const selected = claimOutcome(state.signals.outcome, result);
    if (selected.kind === result.kind && selected.code === result.code) {
      const bytes = new TextEncoder().encode(`${error instanceof Error ? error.stack : error}\n`);
      const stderr = processHost?.descriptors.get(2)?.resource;
      if (stderr?.kind === "pipe" || stderr?.kind === "terminal") stderr.write([bytes]);
      else if (!request) writeSync(2, bytes);
    }
    finish(1);
  }
}

void (isMainThread ? main() : run(workerData as GuestData)).catch(error => {
  writeSync(2, `${error instanceof Error ? error.stack : error}\n`);
  nodeProcess.exit(1);
});
