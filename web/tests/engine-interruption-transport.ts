import type { RuntimeWorkerRequest } from "waffle/browser/worker";
import type { RunRequest } from "../src/bun-executor";
import { workerProcessState } from "waffle/proc/worker-client";

type ProbeRequest = Pick<RuntimeWorkerRequest, "runtimeProcess"> & Partial<Pick<RunRequest, "engine" | "adapter">>;
/** Exact views of the real generic request, including nonzero signal-record offsets.
 * Bun's runtime_proc.poll waits on service readiness; preview1 poll_oneoff waits on its
 * process interrupt cell. Never manufacture a legacy budget or a detached wait word. */
export function engineInterruptionTransport(request: ProbeRequest) {
  if (!request.runtimeProcess) throw new Error("interruption probe requires the production signal and wait transport");
  const state = workerProcessState(request.runtimeProcess);
  const preview1 = request.engine === undefined || request.adapter === "preview1";
  return {
    route: "runtimeProcess" as const,
    requestedSignal: state.signals.requestedSignal,
    signalState: state.signals.signalState,
    waitWord: preview1 ? state.signals.interrupt : state.wake,
  };
}
