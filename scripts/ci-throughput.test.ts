import { expect, test } from "bun:test";
import { measureThroughput } from "./ci-throughput";

const start = "2026-11-11T19:00:00Z", end = "2026-11-11T20:00:00Z";
const run = { id: 1, head_branch: "main", event: "push", status: "completed", conclusion: "success", created_at: start, updated_at: "2026-11-11T19:40:00Z" };
const job = { id: 2, run_id: 1, name: "Rust", status: "completed", conclusion: "success", created_at: "2026-11-11T19:10:00Z", started_at: "2026-11-11T19:12:00Z", completed_at: "2026-11-11T19:32:00Z" };

test("queue delay starts when the job is ready, excluding upstream dependency time", () => {
  const result = measureThroughput({ observedAt: end, runs: [run], jobs: [job] }, start, end);
  expect(result.queueSeconds).toEqual({ samples: 1, p50: 120, p95: 120, max: 120 });
  expect(result.runnerMinutes).toBe(20);
  expect(result.completedRunsPerHour).toBe(1);
  expect(result.successfulMainRunsPerHour).toBe(1);
});

test("pending jobs are right-censored rather than treated as zero-wait starts", () => {
  const pending = { ...job, status: "queued", conclusion: null, started_at: null, completed_at: null };
  const result = measureThroughput({ observedAt: end, runs: [], jobs: [pending] }, start, end);
  expect(result.queueSeconds.samples).toBe(0);
  expect(result.queuedJobs[0]?.waitingAtLeastSeconds).toBe(3000);
  expect(result.runnerMinutes).toBe(0);
});

test("cancelled runs do not inflate completed throughput and half-hour windows normalize rates", () => {
  const result = measureThroughput({ observedAt: end, runs: [run, { ...run, id: 3, conclusion: "cancelled" }], jobs: [] }, "2026-11-11T19:30:00Z", end);
  expect(result.completedRunsPerHour).toBe(2);
  expect(result.cancelledRuns).toBe(1);
});

test("skipped placeholders and impossible timestamps cannot count as runner work", () => {
  const invalid = { ...job, completed_at: start };
  const result = measureThroughput({ observedAt: end, runs: [], jobs: [invalid, { ...invalid, id: 3, conclusion: "skipped" }] }, start, end);
  expect(result.runnerMinutes).toBe(0);
  expect(result.invalidJobTimes).toEqual([2]);
});

test("a future or empty measurement window fails instead of producing misleading rates", () => {
  const snapshot = { observedAt: end, runs: [], jobs: [] };
  expect(() => measureThroughput(snapshot, end, start)).toThrow();
  expect(() => measureThroughput(snapshot, start, "2026-11-11T21:00:00Z")).toThrow();
});
