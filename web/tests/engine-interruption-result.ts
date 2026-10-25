import assert from "node:assert/strict";

export function assertEngineInterruptionResult(result: Record<string, any>, benchmark: boolean): void {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cleanup?.safe, true, "page execution quiescence and cleanup");
  // WebDriver JSON cloning represents an absent undefined page field as null.
  assert.equal(result.unsafeCleanup ?? undefined, undefined, "page unsafe cleanup");
  assert.ok(Array.isArray(result.outcomes) && result.outcomes.length > 0, "page functional outcomes");
  assert.ok(result.outcomes.every((outcome: any) => outcome.ok === true && outcome.cleanup?.safe === true), "all page functional cases passed safely");
  assert.deepEqual(result.pageErrors ?? [], [], "page errors");
  assert.equal(result.checks.length, 32, "fourteen engine proofs each plus four browser/Preview1 proofs");
  assert.equal(result.checks.filter((check: any) => check.route === "runtimeProcess").length, 14, "new-route fatal, pending, page-idle and sleepSync proof on both engines");
  for (const engine of ["quickjs", "jsc"]) {
    assert.equal(result.checks.filter((check: any) => check.engine === engine).length, 14, `${engine} complete legacy/new-route case set`);
  }
  assert.equal(new Set(result.checks.map((check: any) => `${check.engine}:${check.name}`)).size, 32, "all named proofs are distinct");
  assert.equal(result.cleanup.activeWorkers, 0, "worker cleanup");
  if (benchmark) assert.equal(result.benchmarks.length, 2, "per-engine overhead measurements");
}

