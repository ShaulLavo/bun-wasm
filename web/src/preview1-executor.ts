import { preview1Executor, type RuntimeWorkerRequest, type WorkerExecutor, type WorkerSetupContext } from "waffle/browser/worker";
import { attachBunTerminal, type BunTerminal } from "./bun-terminal";

/** Base tools such as env must preserve the shell's terminal for their own children. */
export function terminalPreview1Executor(request: RuntimeWorkerRequest) {
  let terminal: BunTerminal | undefined;
  return {
    ...preview1Executor,
    setup({ checkActive }: Pick<WorkerSetupContext, "checkActive">) { terminal = attachBunTerminal(request, checkActive); },
    resolveTerminal: (target: 0 | 1 | 2) => terminal?.resolve(target),
    spawnData: () => terminal?.spawnData() ?? {},
    beforeFinish() { terminal?.dispose(); },
  } satisfies WorkerExecutor;
}
