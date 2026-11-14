import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { requireCiSuccess } from "./ci-result";

const always = ["quality", "package", "web", "web-unit", "web-browser", "process-bundles", "browser-process"];
const rustJobs = ["jsc-identity", "jsc-prebuild", "native-quality", "rust", "browser-guest"];
const sharedJobs = ["shared-jsc-identity", "shared-prebuild", "shared-sysroot"];
const jobIds = always.concat(rustJobs, sharedJobs, ["shared-spidermonkey-prebuild"]);

function fixture(rust = true, shared = true, sharedNative = true) {
  const enabled = new Set(always.concat(rust ? rustJobs : [], shared || sharedNative ? sharedJobs : [], sharedNative ? ["shared-spidermonkey-prebuild"] : []));
  return Object.fromEntries(jobIds.map(id => [id, { result: enabled.has(id) ? "success" : "skipped",
    outputs: id === "quality" ? { rust: String(rust), shared: String(shared), "shared-native": String(sharedNative) } : {} }]));
}

test("aggregate accepts success and only classifier-disabled skips for every selection", () => {
  const selections = [true, false].flatMap(rust => [true, false].flatMap(shared => [true, false].map(native => ({ rust, shared, native }))));
  for (const { rust, shared, native } of selections) expect(() => requireCiSuccess(fixture(rust, shared, native))).not.toThrow();
});

test.each(jobIds)("aggregate rejects failure, cancellation, skips and missing results for selected %s", id => {
  for (const result of ["failure", "cancelled", "skipped", "in_progress", ""]) {
    expect(() => requireCiSuccess({ ...fixture(), [id]: { result } })).toThrow();
  }
  const results = fixture();
  delete results[id];
  expect(() => requireCiSuccess(results)).toThrow();
});

test("guest matrix cannot be hidden by passing Processes results or an unexpected producer-disabled run", () => {
  expect(() => requireCiSuccess({ ...fixture(), "browser-guest": { result: "failure" } })).toThrow("browser-guest must be success");
  expect(() => requireCiSuccess({ ...fixture(false, false, false), "browser-guest": { result: "success" } })).toThrow("browser-guest must be skipped");
});

test("draft results fail even when their skipped jobs would satisfy individual required checks", () => {
  const draft = Object.fromEntries(jobIds.map(id => [id, { result: id === "quality" ? "failure" : "skipped", outputs: {} }]));
  expect(() => requireCiSuccess(draft)).toThrow("Source quality did not pass");
});

test("aggregate rejects absent or malformed selections and unexpected execution", () => {
  for (const outputs of [{}, { rust: "false", shared: "true" }, { rust: "yes", shared: "false", "shared-native": "false" }]) {
    expect(() => requireCiSuccess({ ...fixture(), quality: { result: "success", outputs } })).toThrow();
  }
  expect(() => requireCiSuccess({ ...fixture(false, false, false), rust: { result: "success" } })).toThrow();
  expect(() => requireCiSuccess(null)).toThrow();
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

test("existing required Code quality name is a final non-skippable gate over every real job", () => {
  const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
  const jobs = object(workflow.jobs);
  const gate = object(jobs["ci-result"]);
  expect(Object.keys(jobs).filter(id => id !== "ci-result" && id !== "update-status").sort()).toEqual(jobIds.toSorted());
  if (!Array.isArray(gate.needs)) throw new Error("Missing aggregate dependencies");
  expect(gate.needs.toSorted()).toEqual(jobIds.toSorted());
  expect(gate.name).toBe("Code quality");
  expect(object(jobs.quality).name).toBe("Source quality");
  expect(gate.if).toBe("${{ always() && (github.event_name != 'push' || github.ref != 'refs/heads/main' || !cancelled()) }}");
  expect(gate["continue-on-error"]).toBeUndefined();
  expect(gate["timeout-minutes"]).toBe(5);
  if (!Array.isArray(gate.steps)) throw new Error("Missing aggregate steps");
  const steps = gate.steps.map(object);
  const check = steps.find(step => step.name === "Require every selected CI job to pass");
  expect(check).toMatchObject({ env: { CI_RESULTS: "${{ toJSON(needs) }}" }, run: "bun scripts/ci-result.ts" });
  expect(check).not.toHaveProperty("if");
  expect(check).not.toHaveProperty("continue-on-error");
  const reporter = object(jobs["update-status"]);
  if (!Array.isArray(reporter.steps)) throw new Error("Missing update reporter steps");
  const report = reporter.steps.map(object).find(step => step.name === "Report each required result on the tested commit");
  expect(report?.run).toContain("Code quality|ci-result|");
  expect(report?.run).not.toContain("Code quality|quality|");
});
