import assert from "node:assert/strict";
import { runtimeProcChecks, runtimeProcJobWaitChecks } from "./runtime-proc-fixtures";

export type RuntimeProcResult = Record<string, unknown> & {
  ok: boolean;
  checks: string[];
  stopCodes: number[];
  admissionReports: number;
  cleanup: { activeWorkers: number };
  teardown: { forcedWorkers: number; activeWorkers: number };
};

export function checkRuntimeProcResult(completed: unknown, scenario: string, errors: unknown): void {
  assert.ok(completed !== null && typeof completed === "object", "runtime_proc result required");
  assert.ok("ok" in completed && "checks" in completed && "stopCodes" in completed && "cleanup" in completed && "teardown" in completed, "runtime_proc result fields required");
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.deepEqual(completed.checks, Array.from<string>(scenario === "job-wait" ? runtimeProcJobWaitChecks : runtimeProcChecks));
  assert.deepEqual(completed.stopCodes, scenario === "pipes" ? [130, 137] : []);
  const { cleanup, teardown } = completed;
  assert.ok(cleanup !== null && typeof cleanup === "object" && "activeWorkers" in cleanup, "cleanup required");
  assert.ok(teardown !== null && typeof teardown === "object" && "forcedWorkers" in teardown && "activeWorkers" in teardown, "teardown required");
  assert.equal(cleanup.activeWorkers, 0);
  assert.equal(teardown.forcedWorkers, 0);
  assert.equal(teardown.activeWorkers, 0);
  assert.deepEqual(errors, []);
}
