import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { requireCiSuccess } from "./ci-result";

const always = ["selection", "quality", "package", "web", "web-unit", "web-browser", "process-bundles", "browser-process"];
const rustJobs = ["jsc-identity", "jsc-prebuild", "native-quality", "rust", "browser-guest"];
const sharedJobs = ["shared-prebuild", "shared-sysroot"];
const jobIds = always.concat(rustJobs, sharedJobs, ["shared-spidermonkey-prebuild"]);

function fixture(rust = true, shared = true, sharedNative = true) {
  const enabled = new Set(always.concat(rust ? rustJobs : [], shared || sharedNative ? sharedJobs : [], sharedNative ? ["shared-spidermonkey-prebuild"] : []));
  return Object.fromEntries(jobIds.map(id => [id, { result: enabled.has(id) ? "success" : "skipped",
    outputs: id === "selection" ? { rust: String(rust), shared: String(shared), "shared-native": String(sharedNative) } : {} }]));
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
    expect(() => requireCiSuccess({ ...fixture(), selection: { result: "success", outputs } })).toThrow();
  }
  expect(() => requireCiSuccess({ ...fixture(false, false, false), rust: { result: "success" } })).toThrow();
  expect(() => requireCiSuccess(null)).toThrow();
});

test("passing consumers cannot hide a failed source check or selector", () => {
  expect(() => requireCiSuccess({ ...fixture(), quality: { result: "failure" } })).toThrow("Source quality did not pass");
  expect(() => requireCiSuccess({ ...fixture(), selection: { ...fixture().selection, result: "failure" } })).toThrow("CI selection did not pass");
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = object(workflow.jobs);

function steps(id: string): Record<string, unknown>[] {
  const entries = object(jobs[id]).steps;
  if (!Array.isArray(entries)) throw new Error(`Missing ${id} steps`);
  return entries.map(object);
}

test("selection fans out before source probes, with both results retained by the aggregate", () => {
  expect(object(jobs.selection).needs).toBeUndefined();
  expect(object(jobs.quality).needs).toBe("selection");
  expect(object(jobs.selection).outputs).toMatchObject({ base: "${{ steps.refs.outputs.base }}", head: "${{ steps.refs.outputs.head }}" });
  for (const [id, value] of Object.entries(jobs)) {
    if (["quality", "ci-result", "update-status"].includes(id)) continue;
    const job = object(value);
    const dependencies = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(dependencies, id).not.toContain("quality");
    expect(JSON.stringify(job), id).not.toContain("needs.quality.");
  }
  const selection = JSON.stringify(jobs.selection);
  expect(selection).not.toMatch(/ci-install|bun install|bun run quality|ci-bun-cache/);
  expect(steps("quality").find(step => step.name === "Blocking quality gates")?.env)
    .toMatchObject({ JSCPD_BASE_REF: "${{ needs.selection.outputs.base }}" });
  const publish = steps("quality").find(step => step.name === "Publish the completed dependency cache");
  expect(publish?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.bun-dependencies.outputs.cache-hit != 'true'");
  expect(publish?.with).toEqual({ path: ".ci-bun-cache", key: "${{ steps.bun-dependencies.outputs.cache-primary-key }}" });
});

test.each(["refs", "changes", "browser-guest-batches", "web-browser-shards"])("selection propagates a failing %s command", id => {
  const command = steps("selection").find(step => step.id === id)?.run;
  if (typeof command !== "string") throw new Error(`Missing ${id} command`);
  const execution = spawnSync("bash", ["-euc", `bun() { return 42; }\n${command}`], {
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", BASE: "a".repeat(40), HEAD: "b".repeat(40), GITHUB_OUTPUT: "/dev/null" },
    encoding: "utf8", timeout: 3000,
  });
  expect(execution.status, execution.stderr).toBe(42);
});

test("draft admission and missing cumulative main selection fail closed", () => {
  const draft = steps("selection").find(step => step.name === "Require a ready PR");
  expect(draft?.if).toBe("github.event_name == 'pull_request' && github.event.pull_request.draft");
  const changes = steps("selection").find(step => step.id === "changes");
  for (const command of [draft?.run, changes?.run]) {
    if (typeof command !== "string") throw new Error("Missing selection guard");
    const execution = spawnSync("bash", ["-euc", command], {
      env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", MAIN_SELECTION: "", GITHUB_OUTPUT: "/dev/null" },
      encoding: "utf8", timeout: 3000,
    });
    expect(execution.status).toBe(1);
  }
});

test("existing required Code quality name is a final non-skippable gate over every real job", () => {
  const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
  const jobs = object(workflow.jobs);
  const gate = object(jobs["ci-result"]);
  expect(Object.keys(jobs).filter(id => id !== "ci-result" && id !== "update-status").sort()).toEqual(jobIds.toSorted());
  if (!Array.isArray(gate.needs)) throw new Error("Missing aggregate dependencies");
  expect(gate.needs.toSorted()).toEqual(jobIds.toSorted());
  expect(gate.name).toBe("Code quality");
  expect(object(jobs.quality).name).toBe("Source quality");
  expect(gate.if).toBe("${{ always() }}");
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
