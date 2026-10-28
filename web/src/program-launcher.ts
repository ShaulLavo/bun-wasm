import type { GuestLauncher } from "waffle";

/** Page composition for Waffle's generic WASI worker. The service owns the process. */
export function programLauncher(workerUrl: URL): GuestLauncher {
  return (context, service) => service.launchWorker(context, {
    workerUrl: workerUrl.href,
    request: {
      module: context.module,
      args: context.request.argv,
      env: context.request.env,
      interruptible: context.interruptible,
    },
  });
}
