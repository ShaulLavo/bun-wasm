// Page-side launchers: one Waffle worker per Bun or preview1 process. The service owns admission,
// descriptors, signals and filesystem fences; these only describe the worker to start.
import type { GuestLauncher, ProcessService } from "waffle";
import type { ProcessContext } from "waffle/proc";
import type { Engine, RunRequest } from "./bun-executor";

export interface BunLauncherOptions {
  /** The module worker URL that runs createBunExecutor (worker.ts). */
  workerUrl: string;
  /** Rewrites a child's executable name, such as `bun` to the spawning run's engine program. */
  executableName?(context: ProcessContext, service: ProcessService): ((name: string) => string) | undefined | Promise<((name: string) => string) | undefined>;
}

/** The service worker at ./__bunwasm/ (sw.ts) serves named module URLs for import cycles. */
function scopedWorker(workerUrl: string): boolean {
  return new URL(workerUrl).pathname.endsWith("/__bunwasm/worker.js");
}

/** Launches `bun:<engine>` programs in the Bun worker. */
export function bunLauncher(engine: Engine, options: BunLauncherOptions): GuestLauncher {
  return async (context, service) => {
    const executableName = await options.executableName?.(context, service);
    // One Cache Storage cache per process holds its modules; deleted when the process is stopped.
    const moduleCache = engine === "browser" && scopedWorker(options.workerUrl) ? `bunwasm-m-${crypto.randomUUID()}` : null;
    return service.launchWorker<RunRequest>(context, {
      workerUrl: options.workerUrl,
      request: {
        engine, adapter: "bun", module: context.module, interruptible: context.interruptible,
        args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd },
        trace: false, net: null, moduleCache,
      },
      cleanup: () => { if (moduleCache) void caches.delete(moduleCache); },
      executableName,
    });
  };
}

/** Launches a third-party preview1 program, with no Bun slots, in the sibling preview1 worker. */
export function preview1Launcher(options: BunLauncherOptions): GuestLauncher {
  return async (context, service) => {
    const executableName = await options.executableName?.(context, service);
    return service.launchWorker(context, {
      workerUrl: new URL("./preview1-worker.js", options.workerUrl).href,
      request: { module: context.module, args: context.request.argv, env: { ...context.request.env, PWD: context.request.cwd }, interruptible: context.interruptible },
      // Alias selection belongs to the Bun composition root, including recursive preview1
      // guests. The reusable worker never guesses that an unknown executable is Bun.
      executableName,
    });
  };
}
