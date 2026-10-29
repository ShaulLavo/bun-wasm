import type { AcceptanceEngine, PhaseResult } from "./next-acceptance-model";

interface Phase {
  phase: string;
  engine: AcceptanceEngine;
  observedEngine: string;
  timeoutMs: number;
  operation(): Promise<void>;
  cancel(): Promise<void>;
  record(result: PhaseResult): void;
}

async function boundedOperation(phase: Phase) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Promise<void> | undefined;
  let expired = false;
  const deadline = new Error(`Phase ${phase.phase} deadline exceeded (${phase.timeoutMs}ms)`);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      cancellation = Promise.resolve().then(phase.cancel);
      void cancellation.then(() => reject(deadline), error => reject(new AggregateError([deadline, error], "Phase deadline and cancellation failed")));
    }, phase.timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(phase.operation), timeout]);
    if (expired) throw deadline;
  } catch (error) {
    if (expired) throw deadline;
    throw error;
  } finally { clearTimeout(timer); await cancellation; }
}

/** Cancellation owns the operation's resources and must settle only after they are released. */
export async function runAcceptancePhase(phase: Phase): Promise<PhaseResult> {
  const started = performance.now();
  const identity = { phase: phase.phase, engine: phase.engine, observedEngine: phase.observedEngine, budgetMs: phase.timeoutMs };
  let result: PhaseResult;
  try {
    await boundedOperation(phase);
    result = { ...identity, durationMs: Math.round(performance.now() - started), status: "pass", detail: "Assertions passed" };
  } catch (error) {
    result = { ...identity, durationMs: Math.round(performance.now() - started), status: "fail", reason: String(error) };
  }
  phase.record(result);
  return result;
}
