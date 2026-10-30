import { beginMemorySnapshot, endMemorySnapshot, memoryCommandId, recordMemorySnapshot } from "./memory-telemetry.js";
import { programLinkPlan } from "../../src/assets.js";
// Running bun.wasm from a page: loading the engine's wasm, and starting one `bun …` command in a
// fresh worker with its networking (fetch, Bun.serve previews). Shared by the playground (main.ts)
// and the sandbox (../sandbox/).

import type { Runtime } from "waffle";
import { ENGINES, loadWasm, MODULE_SCOPE } from "./engine-loader";
import { createBunNetworkHelper, dispatchBunNetwork, type BunNetworkOptions, type RuntimeNetworkHelper } from "./net/helper";
import { createRing } from "./net/ring";
import { SubprocessBroker, type ExecutableRegistration } from "./subprocess-broker";
import { siblingWorkerUrl } from "./bun-launcher.js";
import { createNotificationBridge, type NotificationBridge } from "waffle/browser/notification-relay";
import { isToolCommand } from "./tool-command";
import { ENGINE_BIN, bunEnvironment, engineEnvironment } from "../../src/executable-paths.js";
import { claimOutcome, readOutcome, type OutcomeWord } from "waffle/proc/outcome";
import { waitStatus } from "waffle/proc/wait-status";
import { installLookupServer } from "./net/lookup.js";
import type { Engine, RunRequest, WorkerMessage } from "./bun-executor";
import { runtimeSharedObjectRoute, type SharedObjectRoute } from "./shared-objects/runtime.js";
import type { BunSharedConnection } from "./shared-objects/protocol.js";

let toolsModule: Promise<WebAssembly.Module> | undefined;
function loadTools(): Promise<WebAssembly.Module> {
  return toolsModule ??= loadWasm("bun-tools.wasm", () => {})
    .then(result => result.module)
    .catch(error => { toolsModule = undefined; throw error; });
}

export interface RunOptions {
  engine: Engine;
  module: WebAssembly.Module;
  /** Arguments after `bun`. */
  args: string[];
  env: Record<string, string>;
  /** Shared service owned by the page, also used by editor and shell. */
  runtime: Runtime;
  network?: BunNetworkOptions;
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

function registerEngineCommands(subprocess: SubprocessBroker, programs: Set<string>, engine: Engine, module: Extract<ExecutableRegistration, { adapter: "bun" }>["module"]): void {
  for (const command of ["bun", "node", "nodejs"]) {
    const path = `${ENGINE_BIN[engine]}/${command}`;
    subprocess.register(path, { module, adapter: "bun", engine });
    programs.add(path);
  }
}

function registerEnginePrograms(subprocess: SubprocessBroker, programs: Set<string>, selected: Engine, adapter: RunRequest["adapter"], selectedModule: WebAssembly.Module): void {
  const engines: Engine[] = ["quickjs", "jsc", "browser"];
  for (const engine of engines.concat(selected === "hermes" ? ["hermes"] : [])) {
    const name = `${ENGINE_BIN[engine]}/bun`;
    if (programs.has(name)) continue;
    let loading: Promise<WebAssembly.Module> | undefined;
    const module = engine === selected && adapter !== "preview1" ? selectedModule
      : () => loading ??= loadWasm(new URL(ENGINES[engine].wasm, location.href).href, () => {}).then(result => result.module);
    registerEngineCommands(subprocess, programs, engine, module);
  }
}

function acceptRootSharedConnection(route: SharedObjectRoute | undefined, message: BunSharedConnection, terminal: boolean): string | undefined {
  if (terminal) { route?.close(); message.port.close(); return; }
  try {
    if (route?.accept(message)) return;
    message.port.close();
    return "Bun shared-object route is unavailable";
  } catch (error) {
    route?.close();
    return String(error);
  }
}

/** Fences the relay and stops its worker after the root worker's physical stop, as Waffle's
 * process broker does; a failed stop is reported, never retried. */
function releaseNotifications(bridge: NotificationBridge | undefined): void {
  void bridge?.dispose().catch(error => console.error("bun-wasm: notification relay stop failed", error));
}

/** Starts `bun <args>` in a fresh worker, rooting a process tree in the page's runtime. */
export function startRun(options: RunOptions, hooks: RunHooks): Run {
  const ring = options.adapter !== "preview1" && globalThis.crossOriginIsolated === true ? createRing() : null;
  const lookupChannel = options.engine === "browser" && options.adapter !== "preview1" ? new MessageChannel() : null;
  let helper: RuntimeNetworkHelper | undefined;
  let socketRoot: Awaited<ReturnType<typeof options.runtime.filesystem.directoryHandle>> | undefined;
  let disposeLookup: (() => void) | undefined;
  const moduleCache = options.moduleScope ? `bunwasm-m-${crypto.randomUUID()}` : null;
  // The runtime exists only on an isolated page, so every run roots a process tree. The root
  // worker, its children and the shell all spawn through the same service; its transport and
  // client chunks load on first use rather than with the page.
  const filesystemIdentity = (options.runtimeProcess?.data as { filesystem?: import("waffle/fs").FilesystemIdentity } | undefined)?.filesystem;
  const pid = options.runtime.identities.pid(), job = options.runtime.identities.job();
  const memoryTelemetryId = crypto.randomUUID();
  const workerUrl = new URL(options.moduleScope ? `${MODULE_SCOPE}worker.js` : "./worker.js", location.href).href;
  let notifications: NotificationBridge | undefined;
  let request: RunRequest;
  try {
    request = {
      engine: options.engine,
      adapter: options.adapter,
      runtimeProcess: options.runtimeProcess,
      module: options.module,
      linkPlan: programLinkPlan(options.module),
      args: [`${ENGINE_BIN[options.engine]}/bun`].concat(options.args),
      env: { ...engineEnvironment(options.engine, options.adapter === "preview1" ? options.env : bunEnvironment(options.env)), BUNWASM_EXEC_PATH: `${ENGINE_BIN[options.engine]}/bun` },
      filesystem: filesystemIdentity ? options.runtime.filesystem.connect(filesystemIdentity) : options.runtime.filesystem.fork(),
      trace: options.trace ?? false,
      net: ring,
      moduleCache,
      lookupPort: lookupChannel?.port2,
      slots: slotsMode(),
    };
  } catch (error) {
    lookupChannel?.port1.close();
    lookupChannel?.port2.close();
    throw error;
  }
  let sharedRoute: SharedObjectRoute | undefined;
  try {
    sharedRoute = options.engine === "browser" && options.adapter !== "preview1"
      ? runtimeSharedObjectRoute(options.runtime) : undefined;
    request.sharedObjects = sharedRoute ? { owner: sharedRoute.owner } : undefined;
  } catch (error) {
    request.filesystem.port.close();
    request.lookupPort?.close();
    lookupChannel?.port1.close();
    lookupChannel?.port2.close();
    sharedRoute?.close();
    throw error;
  }
  let rootOutcome: OutcomeWord | null = null;
  let rootPid = pid, rootJob = job;
  let rootAcknowledged = false;
  let rootQuiescence: Promise<void> | undefined;
  let rootStopped = false;
  let rootConsumerRelease: (() => void) | undefined;
  let worker: Worker | undefined;
  let subprocess: SubprocessBroker | undefined;
  let finished = false;
  let confirmed = false;
  let setupRevoked = false;
  const quiesceRoot = (): void | Promise<void> => {
    if (rootAcknowledged) return;
    return rootQuiescence ??= options.runtime.filesystem.quiesce(request.filesystem);
  };
  let workerStopped = false;
  const releaseRootConsumer = () => { rootConsumerRelease?.(); rootConsumerRelease = undefined; };
  const stopWorker = () => {
    sharedRoute?.close();
    if (workerStopped) return;
    workerStopped = true;
    request.filesystem.port.close();
    request.lookupPort?.close();
    lookupChannel?.port1.close();
    lookupChannel?.port2.close();
    disposeLookup?.();
    worker?.terminate();
    releaseNotifications(notifications);
    try { helper?.dispose(); }
    finally { socketRoot?.release(); socketRoot = undefined; if (moduleCache) void caches.delete(moduleCache); }
  };
  const stopRoot = () => { if (rootStopped) return; rootStopped = true; stopWorker(); };
  const starting = performance.now();
  let settle: (result: RunResult) => void = () => {};
  const done = new Promise<RunResult>((resolve) => (settle = resolve));
  let selectedResult: RunResult | undefined;
  let outcomeTimer: ReturnType<typeof setTimeout> | null = null;
  function confirm(ownedDisposal = false) {
    if (confirmed || (options.runtime.disposed && !ownedDisposal)) return;
    confirmed = true;
    endMemorySnapshot(memoryTelemetryId);
    // The admission fence proves completion. Never make run.done depend on terminate().
    settle(selectedResult!);
    stopWorker();
    releaseRootConsumer();
  }
  function finish(result: RunResult, acknowledged = false, signal?: number, ownedDisposal = false) {
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
    if (!ownedDisposal) subprocess?.revokeRuntimeProcess(rootPid);
    selectedResult = result;
    finished = true;
    sharedRoute?.close();
    if (outcomeTimer !== null) clearTimeout(outcomeTimer);
    outcomeTimer = null;
    if (acknowledged) {
      rootAcknowledged = true;
      options.runtime.filesystem.reap(request.filesystem);
    }
    const rootExit = ownedDisposal ? undefined : subprocess?.rootExit(result.code);
    // Outcome/revocation is immediate; confirmation and physical stop require the filesystem
    // fence. An adopted root's exit already joins it; only a root the service never saw needs its own.
    const quiescence = acknowledged || ownedDisposal || rootExit ? undefined : quiesceRoot();
    if (quiescence || rootExit) void Promise.all([quiescence, rootExit]).then(() => confirm())
      .catch(error => { if (!options.runtime.disposed) console.error("bun-wasm: root teardown failed", error); });
    else confirm(ownedDisposal);
  }
  try {
    rootConsumerRelease = options.runtime.retainConsumer({
      filesystem: request.filesystem,
      revoke: () => { if (finished) return; if (!subprocess) { setupRevoked = true; sharedRoute?.close(); stopWorker(); return; } finish({ code: 137 }, false, 9, true); },
      stop: stopRoot,
    });
    subprocess = new SubprocessBroker(workerUrl, options.runtime, {
      loadTools, network: options.network,
      rootFilesystem: request.filesystem, rootAcknowledged: () => rootAcknowledged,
      stopRoot: () => finish({ code: rootOutcome ? readOutcome(rootOutcome)?.status ?? 137 : 137 }, false, undefined, true),
      output: (fd, data) => (fd === 2 ? hooks.stderr : hooks.stdout)(data),
    });
  } catch (error) {
    sharedRoute?.close();
    releaseRootConsumer();
    stopWorker();
    throw error;
  }
  if (setupRevoked || finished) {
    sharedRoute?.close();
    releaseRootConsumer();
    stopWorker();
    throw new Error("Bun root runtime was revoked during setup");
  }
  // Real engine executables are registered once per runtime. Each root inherits an ordinary
  // PATH selecting its engine; explicit absolute paths are never rewritten.
  try {
    let programs = registeredPrograms.get(options.runtime);
    if (!programs) registeredPrograms.set(options.runtime, programs = new Set());
    if (!subprocess) throw new Error("Bun process controller did not initialize");
    registerEnginePrograms(subprocess, programs, options.engine, options.adapter, options.module);
  } catch (error) {
    sharedRoute?.close();
    releaseRootConsumer();
    stopWorker();
    throw error;
  }
  const onNetwork = (message: unknown) => {
    if (!helper) return;
    try { dispatchBunNetwork(helper, message); }
    catch (error) { finish({ code: 126, error: String(error) }); }
  };
  const onMessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
    if (recordMemorySnapshot(msg)) return;
    if (msg.type === "bun-shared-connect") {
      const selected = rootOutcome && readOutcome(rootOutcome);
      const error = acceptRootSharedConnection(sharedRoute, msg, options.runtime.disposed || finished || Boolean(selected));
      if (error) finish({ code: 126, error });
      return;
    }
    if (options.runtime.disposed) return;
    if (finished) {
      if (msg.type === "runtime-proc") subprocess?.rejectRuntimeMessage(msg);
      return;
    }
    if (msg.type === "cleanup-error") {
      console.error("bun-wasm: root cleanup failed", msg.message);
      finish({ code: msg.code }, false, msg.signal);
      return;
    }
    const selected = rootOutcome && readOutcome(rootOutcome);
    if (selected?.kind === "signaled" && msg.type !== "exit" && msg.type !== "error") {
      // Reject capabilities at the dispatch boundary too: the periodic observer need not have
      // run yet when a guest catches its own terminal unwind and sends more messages.
      if (msg.type === "runtime-proc") subprocess?.rejectRuntimeMessage(msg);
      finish({ code: selected.status }, false, selected.code);
      return;
    }
    if (msg.type === "runtime-proc") {
      void subprocess?.runtimeMessage(msg, rootPid).catch(error => console.error("bun-wasm: process message failed", error));
      return;
    }
    if (msg.type === "phase") {
      const duration = msg.name === "worker-start" ? performance.now() - starting : msg.duration;
      performance.measure(`bunwasm:${msg.name}`, { start: performance.now() - duration, duration });
      hooks.phase?.(msg.name, duration);
      return;
    }
    if (msg.type === "net") {
      onNetwork(msg);
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
  const onError = (event: ErrorEvent) => {
    event.preventDefault();
    finish({ code: 1, error: `worker error (${workerUrl}): ${event.message || (event.error instanceof Error ? event.error.message : "the browser could not load or execute the worker script")}${event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : ""}` });
  };
  let interrupted = false;
  let prepared = false;
  const pendingKills: (2 | 9 | 15)[] = [];
  void (async () => {
    if (finished || options.runtime.disposed) return;
    // The runtime's pool usually has this worker started already, so the command doesn't wait
    // for the worker script and its imports. A taking failure is a startup failure (126).
    const [taken, { workerProcessState, createWorkerProcessTransport }] = await Promise.all([
      subprocess.takeWorker(workerUrl), import("waffle/proc/worker-client"),
    ]);
    if (finished || workerStopped || options.runtime.disposed) return taken.terminate();
    worker = taken;
    worker.onmessage = onMessage;
    worker.onerror = onError;
    const transport = request.runtimeProcess ??= createWorkerProcessTransport({ pid, job, identity: options.runtime.identities.buffer });
    const state = workerProcessState(transport);
    const { port: _port, ...filesystem } = request.filesystem;
    transport.data = { ...(transport.data as object | undefined), filesystem };
    if (!subprocess || !await subprocess.adoptRuntimeRoot(transport, () => finished)) return;
    rootOutcome = state.signals.outcome;
    rootPid = state.pid;
    rootJob = state.job;
    releaseRootConsumer();
    prepared = true;
    for (const signal of pendingKills) kill(signal);
    pendingKills.length = 0;
    if (preparationStopped()) return;
    if (options.adapter !== "preview1" && isToolCommand(options.args)) {
      request.module = await loadTools();
      request.linkPlan = programLinkPlan(request.module);
    }
    if (preparationStopped()) return;
    let network;
    if (ring || lookupChannel) {
      network = await options.runtime.network();
      if (preparationStopped()) return;
      if (lookupChannel) disposeLookup = installLookupServer(lookupChannel.port1, network);
      if (ring) {
        const root = await options.runtime.filesystem.directoryHandle("/");
        if (preparationStopped() || workerStopped) { root.release(); return; }
        socketRoot = root;
        helper = createBunNetworkHelper(network, ring, {
          ...options.network, pathScope: { filesystem: request.filesystem, directory: root.handle },
        });
        if (workerStopped) { helper.dispose(); socketRoot?.release(); socketRoot = undefined; return; }
      }
      if (preparationStopped()) return;
    }
    if (!preparationStopped() && worker) {
      // A networked root sleeps in the network poll; Waffle's page-owned notification relay
      // wakes it on filesystem commits, as launchWorker arranges for every child process.
      // A relay created after the physical stop would have no later stop to release it.
      if (ring && !workerStopped) {
        notifications = createNotificationBridge(siblingWorkerUrl(workerUrl, "notification-worker.js"));
        request.notifications = notifications.connection;
      }
      const transfers = [request.filesystem.port].concat(request.lookupPort ? [request.lookupPort] : [], request.notifications ? [request.notifications.port] : []);
      request.memoryTelemetry = beginMemorySnapshot(options.engine, memoryTelemetryId, memoryCommandId(options.runtime, rootJob));
      worker.postMessage(request, transfers);
      watchOutcome();
    }
  })().catch(error => finish({ code: 126, error: String(error) }));
  function preparationStopped(): boolean {
    if (finished || options.runtime.disposed) return true;
    const result = rootOutcome && readOutcome(rootOutcome);
    if (!result) return false;
    finish({ code: waitStatus(result) }, false, result.kind === "signaled" ? result.code : undefined);
    return true;
  }
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
  function kill(requestedSignal?: 2 | 9 | 15): void {
    if (finished) return;
    const signal = requestedSignal ?? (interrupted ? 9 : 2);
    interrupted = true;
    if (!prepared && options.runtimeProcess) { pendingKills.push(signal); return; }
    if (!prepared) { finish({ code: 128 + signal }, false, signal); return; }
    // The broker synchronously publishes every job member before any teardown callback. Root
    // HANDLE/IGNORE stays alive; DEFAULT selects its typed outcome without guest cooperation.
    void subprocess?.killJob(rootJob, signal).catch(error => console.error("bun-wasm: job signal failed", error));
    const result = readOutcome(rootOutcome!);
    if (result) finish({ code: waitStatus(result) }, false, result.kind === "signaled" ? result.code : undefined);
  }
  return { done, kill };
}
