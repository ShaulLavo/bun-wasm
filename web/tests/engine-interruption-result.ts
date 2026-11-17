import assert from "node:assert/strict";
import { defaultInterruptionEngines, interruptionProofs, nativePollingEngines, type InterruptionEngine } from "./engine-interruption-cases";

export function assertEngineInterruptionResult(result: Record<string, any>, benchmark: boolean, engines: readonly InterruptionEngine[] = defaultInterruptionEngines): void {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cleanup?.safe, true, "page execution quiescence and cleanup");
  // WebDriver JSON cloning represents an absent undefined page field as null.
  assert.equal(result.unsafeCleanup ?? undefined, undefined, "page unsafe cleanup");
  assert.ok(Array.isArray(result.outcomes) && result.outcomes.length > 0, "page functional outcomes");
  assert.ok(result.outcomes.every((outcome: any) => outcome.ok === true && outcome.cleanup?.safe === true), "all page functional cases passed safely");
  assert.deepEqual(result.pageErrors ?? [], [], "page errors");
  const expected = interruptionProofs(engines);
  const identity = (check: { engine: string; route: string; name: string }) => JSON.stringify([check.engine, check.route, check.name]);
  assert.equal(result.checks.length, expected.length, "all selected paired and Browser/Preview1 proofs");
  const nativeStops = engines.filter(engine => nativePollingEngines.includes(engine)).length;
  assert.equal(result.checks.filter((check: { route: string }) => check.route === "runtimeProcess").length, 8 * engines.length + nativeStops + 1, "selected new-route proofs");
  assert.deepEqual(result.checks.map(identity).sort(), expected.map(identity).sort(), "exact selected named proofs");
  assert.equal(new Set(result.checks.map(identity)).size, expected.length, "all named proofs are distinct");
  assert.equal(result.cleanup.activeWorkers, 0, "worker cleanup");
  if (benchmark) assert.equal(result.benchmarks.length, engines.length, "per-engine overhead measurements");
}

