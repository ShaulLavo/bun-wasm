import { boxId } from "../goals-matrix/catalog";
import { smokeCases, smokePhases } from "../iphone-smoke/cases";
import { object } from "../goals-matrix/evidence";

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected smoke evidence rows");
  return value.map(object);
}

function onlyFailure(value: unknown, phase: string, error: string): boolean {
  const failures = records(value);
  return failures.length === 1 && failures[0]?.phase === phase && failures[0].error === error;
}

function functionalPhases(result: Record<string, unknown>): Record<string, unknown>[] {
  const phases = records(result.phases);
  if (phases.length !== smokePhases.length || phases.some((phase, index) => phase.phase !== smokePhases[index])) throw new Error("Incomplete smoke phases");
  if (phases.slice(0, -1).some(phase => phase.status !== "pass")) throw new Error("Functional smoke failure");
  return phases;
}

function classify(data: Record<string, unknown>): boolean {
  if (data.kind !== "manual-iphone-smoke" || data.failedPhase !== "cleanup" || records(data.failures).length !== 0) return false;
  const cases = records(data.cases);
  if (cases.length !== smokeCases.length || cases.some((result, index) => result.id !== boxId(smokeCases[index]!))) return false;
  let failure: string | undefined;
  for (const result of cases) {
    if (failure !== undefined) {
      if (result.status !== "blocked" || records(result.phases).length !== 0 || !onlyFailure(result.failures, "prerequisite", "Previous case cleanup failed: " + failure)) return false;
      continue;
    }
    const cleanup = functionalPhases(result).at(-1)!;
    if (result.status === "pass" && cleanup.status === "pass" && records(result.failures).length === 0) continue;
    if (result.status !== "fail" || cleanup.status !== "fail" || typeof cleanup.error !== "string" || !/^(?:AggregateError: )?Error: Cannot identify Safari tab count$/.test(cleanup.error)) return false;
    if (!onlyFailure(result.failures, "cleanup", cleanup.error)) return false;
    failure = cleanup.error;
  }
  return failure !== undefined;
}

export function tabCountAlert(data: Record<string, unknown>): boolean {
  try { return classify(data); }
  catch { return false; }
}
