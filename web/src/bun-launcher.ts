// Page-side launchers: one Waffle worker per Bun or preview1 process. The service owns admission,
// descriptors, signals and filesystem fences; these only describe the worker to start.
import type { GuestLauncher } from "waffle";
import type { Engine, RunRequest } from "./bun-executor.js";
import { isToolCommand } from "./tool-command.js";

export interface BunLauncherOptions {
  /** The module worker URL that runs createBunExecutor (worker.ts). */
  workerUrl: string;
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

/**
 * Launches `bun:<engine>` programs in the Bun worker.
 *
 * Service-launched processes get no networking ring (`net: null`): only the run that roots a
 * tree (runner.ts `startRun`) owns one, together with the page hooks that listening servers and
 * the installer cache report to. A private ring per launched process would give each process its
 * own socket namespace, so children could not reach each other's listeners. One namespace shared
 * by every process of a runtime is plan step 6 (plans/browser-runtime.md, "Network"); until it
 * lands, QuickJS and JSC processes started here have no network slots, and the browser engine
 * keeps its direct worker `fetch` (web/README.md, "Bun subprocess workers").
 */
export function bunLauncher(engine: Engine, options: BunLauncherOptions): GuestLauncher {
  return async (context, service) => {
    const module = options.loadTools && isToolCommand(context.request.argv.slice(1))
      ? await options.loadTools() : context.module;
    // One Cache Storage cache per process holds its modules; deleted when the process is stopped.
    const moduleCache = engine === "browser" && scopedWorker(options.workerUrl) ? `bunwasm-m-${crypto.randomUUID()}` : null;
    return service.launchWorker<RunRequest>(context, {
      workerUrl: options.workerUrl,
      request: {
        engine, adapter: "bun", module, interruptible: context.interruptible,
        args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd, BUNWASM_EXEC_PATH: context.request.executable },
        trace: false, net: null, moduleCache,
      },
      cleanup: () => { if (moduleCache) void caches.delete(moduleCache); },
    });
  };
}

/** Launches a third-party preview1 program, with no Bun slots, in the sibling preview1 worker. */
export function preview1Launcher(options: BunLauncherOptions): GuestLauncher {
  return async (context, service) => {
    return service.launchWorker(context, {
      workerUrl: new URL("./preview1-worker.js", new URL(options.workerUrl, base())).href,
      request: { module: context.module, args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd }, interruptible: context.interruptible },
    });
  };
}
