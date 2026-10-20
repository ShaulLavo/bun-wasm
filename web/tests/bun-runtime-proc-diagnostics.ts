import assert from "node:assert/strict";

const startFailure = "runtime: process controller failed Error: bun-runtime-proc-start-failed-control";

export function assertBunRuntimeProcDiagnostics(scenario: string, pageErrors: readonly string[], consoleErrors: readonly string[]): void {
  assert.deepEqual(pageErrors, [], "no uncaught page errors");
  const headings = consoleErrors.map(message => message.split("\n", 1)[0]);
  assert.deepEqual(headings, scenario === "start-failed" ? [startFailure] : [], "exact host console diagnostics");
}
