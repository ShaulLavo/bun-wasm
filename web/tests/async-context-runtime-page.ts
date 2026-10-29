import assert from "node:assert/strict";

export function checkPageReady(report: unknown, browser: string) {
  assert.ok(report && typeof report === "object");
  assert.ok("version" in report && "status" in report && "failures" in report && "cases" in report && "origins" in report);
  assert.equal(report.version, 1);
  assert.equal(report.status, "pass", `${browser}: ${JSON.stringify(report.failures)}`);
  assert.deepEqual(report.failures, []);
  assert.ok(Array.isArray(report.cases) && Array.isArray(report.origins));
  assert.equal(report.cases.length, 12);
  assert.equal(report.origins.length, 12);
  assert.ok(report.origins.some((origin: unknown) => origin && typeof origin === "object" && "compiledOnce" in origin && origin.compiledOnce === true && "kind" in origin && origin.kind === "reused"));
  for (const entry of report.cases) {
    assert.ok(entry && typeof entry === "object" && "requests" in entry);
    assert.deepEqual(entry.requests, ["request-A", "request-B"]);
  }
}
