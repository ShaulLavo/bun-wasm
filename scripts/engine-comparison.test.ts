import { expect, test } from "bun:test";
import { parseMatrixReport, reduceCensus, registerCensus } from "./engine-comparison.ts";

const apps = [{ id: "app", stages: ["install", "dev", "dev:hmr", "build"] }];
const row = (stage: string, status: "pass" | "fail" | "blocked", fields = {}) => ({ app: "app", engine: "quickjs", host: "playground", stage, status, ...fields });

test("fixed census denominator preserves blocked, missing and entirely absent arms", () => {
  const input = parseMatrixReport({ provenance: {}, results: [row("install", "pass"), row("dev", "fail"), row("dev:hmr", "blocked"), row("build", "pass", { host: "native" })] });
  const [quickjs, jsc] = reduceCensus([input], apps, "playground");
  expect(quickjs?.stages).toEqual({ expected: 4, pass: 1, fail: 1, blocked: 1, notRun: 1, measurementError: 0, passRate: 0.25, executedPassRate: 0.5 });
  expect(quickjs?.apps.fail).toBe(1);
  expect(jsc?.stages.notRun).toBe(4);
  expect(reduceCensus([input], apps, "playground")).toHaveLength(2);
  expect(jsc?.stages.executedPassRate).toBeNull();
});

test("duplicate reports cannot inflate the numerator", () => {
  const report = parseMatrixReport({ provenance: {}, results: [row("install", "pass")] });
  expect(() => reduceCensus([report, report], apps, "playground")).toThrow("duplicate");
});

test("network measurement errors cannot be counted as product passes", () => {
  const report = parseMatrixReport({ provenance: {}, results: [row("install", "pass"), row("network-guard", "fail")] });
  const [result] = reduceCensus([report], apps, "playground");
  expect(result?.stages.measurementError).toBe(4);
  expect(result?.stages.pass).toBe(0);
});

test("only successful measured times enter distributions, missing stays null", () => {
  const report = parseMatrixReport({ provenance: {}, results: [row("install", "pass", { durationMs: 42 }), row("dev", "fail", { durationMs: 99 }), row("build", "pass")] });
  const [result] = reduceCensus([report], apps, "playground");
  expect(result?.cells[0]?.successfulTiming?.median).toBe(42);
  expect(result?.cells[1]?.successfulTiming).toBeNull();
  expect(result?.cells[3]?.durationMs).toBeNull();
});

test("matrix boundary rejects invalid status and timings", () => {
  expect(() => parseMatrixReport({ provenance: {}, results: [row("install", "pass", { status: "green" })] })).toThrow("status");
  expect(() => parseMatrixReport({ provenance: {}, results: [row("install", "pass", { durationMs: -1 })] })).toThrow("duration");
});

test("registration derives probes from existing product checks before execution", () => {
  const plan = registerCensus(["vite-react", "hono"], "playground", 6);
  expect(plan.apps.find(app => app.id === "vite-react")?.stages).toContain("dev:hmr");
  expect(plan.apps.find(app => app.id === "hono")?.stages).toContain("start:params-query");
  expect(plan.order).toHaveLength(6);
  expect(new Set(plan.order.map(order => order.join(","))).size).toBe(2);
  expect(() => registerCensus(["typo"], "native", 1)).toThrow("unknown");
  expect(() => registerCensus(["hono"], "native", 2)).toThrow("six");
});
