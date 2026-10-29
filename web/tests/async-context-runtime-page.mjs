import assert from "node:assert/strict";

export function checkPageReady(report, browser) {
  assert.equal(report.version, 1);
  assert.equal(report.status, "pass", `${browser}: ${JSON.stringify(report.failures)}`);
  assert.deepEqual(report.failures, []);
  assert.equal(report.cases.length, 12);
  assert.equal(report.origins.length, 12);
  assert.ok(report.origins.some(origin => origin.compiledOnce && origin.kind === "reused"));
  for (const entry of report.cases) assert.deepEqual(entry.requests, ["request-A", "request-B"]);
}
