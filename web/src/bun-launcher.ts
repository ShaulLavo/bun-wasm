import { programLinkPlan } from "../../src/assets.js";
// Page-side launchers: one Waffle worker per Bun or preview1 process. The service owns admission,
// descriptors, signals and filesystem fences; these only describe the worker to start.
import type { GuestLauncher, Runtime, RuntimeNetworkHelper } from "waffle";
import { normalize } from "waffle/core/path";
import type { Engine, RunRequest } from "./bun-executor.js";
import type { BunNetworkOptions } from "./net/helper.js";
import { readOutcome } from "waffle/proc/outcome";
import { isToolCommand } from "./tool-command.js";
import { installLookupServer } from "./net/lookup.js";

export interface BunLauncherOptions {
  /** The module worker URL that runs createBunExecutor (worker.ts). */
  workerUrl: string;
  runtime: Runtime;
  network?: BunNetworkOptions;
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

export function bunLauncher(engine: Engine, options: BunLauncherOptions): GuestLauncher {
  return (context, service) => launchBunProcess(engine, options, context, service);
}

async function launchBunProcess(engine: Engine, options: BunLauncherOptions, context: Parameters<GuestLauncher>[0], service: Parameters<GuestLauncher>[1]) {
  let revoked = false;
  let helper: RuntimeNetworkHelper | undefined;
  let moduleCache: string | null = null;
  let lookupChannel: BroadcastChannel | undefined;
  let disposeLookup: (() => void) | undefined;
  let released = false;
  const unregister = context.registerRevocation(() => { revoked = true; });
  const active = () => !released && !revoked && !options.runtime.disposed && !readOutcome(context.outcome);
  const cleanup = () => {
    if (released) return;
    released = true;
    unregister();
    try { helper?.dispose(); }
    finally {
      disposeLookup?.();
      lookupChannel = undefined;
      if (moduleCache) void caches.delete(moduleCache);
    }
  };
  const onMessage = (message: unknown) => {
    try { if (active()) dispatch?.(message); }
    catch (error) { context.fail(error); }
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
    helper = createBunNetworkHelper(network, ring, options.network);
    if (engine === "browser" && typeof BroadcastChannel === "function") {
      lookupChannel = new BroadcastChannel(`bun-wasm-dns-${crypto.randomUUID()}`);
      disposeLookup = installLookupServer(lookupChannel, network);
    }
    if (!active()) throw new Error("Bun process launch was revoked");
    const session = helper;
    dispatch = message => dispatchBunNetwork(session, message);
    moduleCache = engine === "browser" && scopedWorker(options.workerUrl) ? `bunwasm-m-${crypto.randomUUID()}` : null;
    return service.launchWorker<RunRequest>(context, {
      workerUrl: options.workerUrl,
      request: {
        engine, adapter: "bun", module, linkPlan: programLinkPlan(module), interruptible: context.interruptible,
        args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd, BUNWASM_EXEC_PATH: normalize(context.request.executable, context.request.cwd) },
        trace: false, net: ring, moduleCache, lookupChannel: lookupChannel?.name,
      },
      cleanup,
      onMessage,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Launches a third-party preview1 program, with no Bun slots, in the sibling preview1 worker. */
export function preview1Launcher(options: Pick<BunLauncherOptions, "workerUrl">): GuestLauncher {
  return async (context, service) => {
    return service.launchWorker(context, {
      workerUrl: new URL("./preview1-worker.js", new URL(options.workerUrl, base())).href,
      request: { module: context.module, args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd }, interruptible: context.interruptible },
    });
  };
}
