import { beginMemorySnapshot, endMemorySnapshot, memoryCommandId, recordMemorySnapshot } from "./memory-telemetry.js";
import { programLinkPlan } from "../../src/assets.js";
import { bunEnvironment } from "../../src/executable-paths.js";
// Page-side launchers: one Waffle worker per Bun or preview1 process. The service owns admission,
// descriptors, signals and filesystem fences; these only describe the worker to start.
import type { GuestLauncher, RuntimeNetworkHelper } from "waffle";
import type { Preview1SocketBinding } from "waffle/browser/preview1-network";
import type { ProcessRuntime } from "../../src/process-runtime.js";
import { normalize } from "waffle/core/path";
import type { Engine, RunRequest } from "./bun-executor.js";
import type { BunNetworkOptions } from "./net/helper.js";
import { runtimeRelay } from "./net/relay.js";
import { readOutcome } from "waffle/proc/outcome";
import { isToolCommand } from "./tool-command.js";
import { installLookupServer } from "./net/lookup.js";
import { runtimeSharedObjectRoute, type SharedObjectRoute } from "./shared-objects/runtime.js";

export interface Preview1LauncherOptions {
  readonly sockets?: readonly Preview1SocketBinding[];
}

export interface BunLauncherOptions {
  /** The module worker URL that runs createBunExecutor (worker.ts). */
  workerUrl: string;
  /**
   * The module worker URL running waffle/browser/notification-worker. Each Bun process gets one
   * helper, so its network poll also wakes on filesystem commits for fs.watch.
   */
  notificationWorkerUrl: string;
  runtime: ProcessRuntime;
  network?: BunNetworkOptions;
  preview1?: Preview1LauncherOptions;
  /** Optional tools artifact supplied by the embedding application, loaded only for lint/fmt. */
  loadTools?(): Promise<WebAssembly.Module>;
}

/** Where a worker URL is resolved from: the page, as `new Worker(url)` does. */
function base(): string {
  return globalThis.location?.href ?? import.meta.url;
}

/**
 * The service worker at ./__bunwasm/ (sw.ts) serves named module URLs for import cycles. Only the
 * classification resolves the URL; the worker is started with the string exactly as given, so a
 * relative URL resolves as the browser resolves it.
 */
function scopedWorker(workerUrl: string): boolean {
  return new URL(workerUrl, base()).pathname.endsWith("/__bunwasm/worker.js");
}

/** A worker bundled beside the Bun worker in the same output directory. */
export function siblingWorkerUrl(workerUrl: string, name: string): string {
  return new URL(`./${name}`, new URL(workerUrl, base())).href;
}

export function bunLauncher(engine: Engine, options: BunLauncherOptions): GuestLauncher {
  return (context, service) => launchBunProcess(engine, options, context, service);
}

async function launchBunProcess(engine: Engine, options: BunLauncherOptions, context: Parameters<GuestLauncher>[0], service: Parameters<GuestLauncher>[1]) {
  const memoryTelemetryId = crypto.randomUUID();
  let revoked = false;
  let helper: RuntimeNetworkHelper | undefined;
  let relay: Awaited<ReturnType<typeof runtimeRelay>>;
  let socketRoot: Awaited<ReturnType<ProcessRuntime["filesystem"]["directoryHandle"]>> | undefined;
  let moduleCache: string | null = null;
  let lookupChannel: BroadcastChannel | undefined;
  let disposeLookup: (() => void) | undefined;
  let released = false;
  let sharedRoute: SharedObjectRoute | undefined;
  const unregister = context.registerRevocation(() => { revoked = true; sharedRoute?.close(); });
  const active = () => !released && !revoked && !options.runtime.disposed && !readOutcome(context.outcome);
  const cleanup = () => {
    if (released) return;
    released = true;
    endMemorySnapshot(memoryTelemetryId);
    unregister();
    const failures: unknown[] = [];
    try { helper?.dispose(); }
    catch (error) { failures.push(error); }
    try { socketRoot?.release(); }
    catch (error) { failures.push(error); }
    socketRoot = undefined;
    sharedRoute?.close();
    disposeLookup?.();
    lookupChannel = undefined;
    const cacheStore = globalThis.caches;
    if (moduleCache && cacheStore) void cacheStore.delete(moduleCache);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Bun launch cleanup failed");
  };
  const onMessage = (message: unknown) => {
    if (recordMemorySnapshot(message)) return;
    try {
      if (!active()) sharedRoute?.close();
      if (sharedRoute?.accept(message)) return;
      if (active()) dispatch?.(message);
    } catch (error) { sharedRoute?.close(); if (active()) context.fail(error); }
  };
  let dispatch: ((message: unknown) => void) | undefined;
  try {
    if (!active()) throw new Error("Bun process launch was revoked");
    const module = options.loadTools && isToolCommand(context.request.argv.slice(1))
      ? await options.loadTools() : context.module;
    if (!active()) throw new Error("Bun process launch was revoked");
    const [{ createRing }, { createBunNetworkHelper, dispatchBunNetwork }, network] = await Promise.all([
      import("./net/ring.js"), import("./net/helper.js"), options.runtime.network(),
    ]);
    if (!active()) throw new Error("Bun process launch was revoked");
    const ring = createRing();
    socketRoot = await options.runtime.filesystem.directoryHandle("/");
    if (!active()) throw new Error("Bun process launch was revoked");
    const pathScope = service.networkPathScope(context, socketRoot.handle);
    relay = await runtimeRelay(options.runtime, options.network?.relay);
    if (!active()) throw new Error("Bun process launch was revoked");
    helper = createBunNetworkHelper(network, ring, { ...options.network, connect: options.network?.connect ?? relay?.connect, pathScope });
    if (engine === "browser" && typeof BroadcastChannel === "function") {
      lookupChannel = new BroadcastChannel(`bun-wasm-dns-${crypto.randomUUID()}`);
      disposeLookup = installLookupServer(lookupChannel, network);
    }
    if (!active()) throw new Error("Bun process launch was revoked");
    const session = helper;
    dispatch = message => dispatchBunNetwork(session, message);
    moduleCache = engine === "browser" && scopedWorker(options.workerUrl) ? `bunwasm-m-${crypto.randomUUID()}` : null;
    if (engine === "browser") sharedRoute = runtimeSharedObjectRoute(options.runtime);
    const memoryTelemetry = beginMemorySnapshot(engine, memoryTelemetryId, memoryCommandId(options.runtime, context.job));
    return service.launchWorker<RunRequest>(context, {
      workerUrl: options.workerUrl,
      notificationWorkerUrl: options.notificationWorkerUrl,
      request: {
        engine, memoryTelemetry, adapter: "bun", module, linkPlan: programLinkPlan(module), interruptible: context.interruptible,
        args: context.request.argv, env: { ...bunEnvironment(context.request.env), PWD: context.request.cwd, BUNWASM_EXEC_PATH: normalize(context.request.executable, context.request.cwd) },
        trace: false, net: ring, moduleCache, lookupChannel: lookupChannel?.name,
        sharedObjects: sharedRoute ? { owner: sharedRoute.owner } : undefined,
      },
      cleanup,
      onMessage,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Launches a third-party preview1 program, with no Bun slots, in the sibling preview1 worker. */
export function preview1Launcher(options: Pick<BunLauncherOptions, "workerUrl" | "network" | "preview1"> & { runtime?: ProcessRuntime }): GuestLauncher {
  return (context, service) => launchPreview1(options, context, service);
}

async function launchPreview1(
  options: Pick<BunLauncherOptions, "workerUrl" | "network" | "preview1"> & { runtime?: ProcessRuntime },
  context: Parameters<GuestLauncher>[0],
  service: Parameters<GuestLauncher>[1],
) {
  const request = preview1Request(context);
  const sockets = options.preview1?.sockets ?? [];
  if (!sockets.length) return launchPreview1Worker(options.workerUrl, context, service, request);
  if (!options.runtime) throw new TypeError("Preview1 sockets require a runtime");
  const relay = await runtimeRelay(options.runtime, options.network?.relay);
  const owner = await createPreview1Network(options.runtime, sockets, relay?.connect);
  return launchOwnedPreview1(options.workerUrl, context, service, request, owner);
}

function preview1Request(context: Parameters<GuestLauncher>[0]) {
  return {
    module: context.module,
    args: context.request.argv,
    env: { ...context.request.env, PWD: context.request.cwd },
    interruptible: context.interruptible,
  };
}

function launchPreview1Worker(
  workerUrl: string,
  context: Parameters<GuestLauncher>[0],
  service: Parameters<GuestLauncher>[1],
  request: ReturnType<typeof preview1Request>,
) {
  return service.launchWorker(context, {
    workerUrl: siblingWorkerUrl(workerUrl, "preview1-worker.js"),
    request,
  });
}

async function createPreview1Network(
  runtime: ProcessRuntime,
  sockets: readonly Preview1SocketBinding[],
  connect: BunNetworkOptions["connect"],
) {
  const { createPreview1Network: createNetwork } = await import("waffle/browser/preview1-network");
  return createNetwork(runtime, { sockets, connect });
}

function launchOwnedPreview1(
  workerUrl: string,
  context: Parameters<GuestLauncher>[0],
  service: Parameters<GuestLauncher>[1],
  request: ReturnType<typeof preview1Request>,
  owner: Awaited<ReturnType<typeof createPreview1Network>>,
) {
  if (!owner) return launchPreview1Worker(workerUrl, context, service, request);
  try {
    return service.launchWorker(context, {
      workerUrl: siblingWorkerUrl(workerUrl, "preview1-worker.js"),
      network: owner,
      request,
    });
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
