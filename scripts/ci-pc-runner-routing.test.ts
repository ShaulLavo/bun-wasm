import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ciExpression, ciRunner } from "./fixtures/ci-expressions";
import { requireCiSuccess } from "./ci-result";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const read = (name: string) => record(Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")));
const workflow = read("ci.yml");
const jobs = record(workflow.jobs);
const warm = read("jsc-prebuild.yml");
const warmJobs = record(warm.jobs);
const pcLabels = ["self-hosted", "linux", "x64", "pc", "bun-wasm"];
const routed = ["jsc-identity", "jsc-prebuild", "native-quality", "rust", "shared-jsc-identity", "shared-prebuild", "shared-spidermonkey-prebuild", "shared-sysroot", "web", "web-unit", "web-browser", "browser-guest", "browser-process"];
const light = ["quality", "package", "process-bundles", "ci-result", "update-status"];
const trust = "github.event.pull_request.head.repo.full_name == github.repository || github.event_name == 'push'";

type Selection = { rust: boolean; shared: boolean; native: boolean };
type Scenario = { event: string; ref: string; repository: string; enabled: string; draft: boolean };
type Result = "success" | "skipped" | "failure" | "cancelled";
const selected: Selection = { rust: true, shared: true, native: true };
const scenario: Scenario = { event: "pull_request", ref: "refs/pull/1/merge", repository: "ShaulLavo/bun-wasm", enabled: "true", draft: false };

function values(input: Scenario, selection = selected): Record<string, unknown> {
  return {
    "vars.BUN_WASM_PC_RUNNER": input.enabled,
    "github.event_name": input.event,
    "github.ref": input.ref,
    "github.repository": "ShaulLavo/bun-wasm",
    "github.event.pull_request.head.repo.full_name": input.repository,
    "github.event.pull_request.draft": input.draft,
    "needs.quality.outputs.rust": String(selection.rust),
    "needs.quality.outputs.shared": String(selection.shared),
    "needs.quality.outputs.shared-native": String(selection.native),
  };
}

function dependencies(job: Record<string, unknown>): string[] {
  if (job.needs === undefined) return [];
  if (typeof job.needs === "string") return [job.needs];
  if (!Array.isArray(job.needs) || !job.needs.every(id => typeof id === "string")) throw new Error("Invalid job dependencies");
  return job.needs;
}

function admitted(job: Record<string, unknown>, input: Scenario, selection: Selection, results: Record<string, Result>, cancelled = false): boolean {
  const condition = String(job.if ?? "${{ true }}");
  const parents = dependencies(job);
  const successful = parents.every(id => results[id] === "success");
  if (!/\b(?:always|success|failure|cancelled)\(\)/.test(condition) && (!successful || cancelled)) return false;
  const expression = condition.replaceAll("always()", "true").replaceAll("success()", String(successful)).replaceAll("cancelled()", String(cancelled));
  const inputs = { ...values(input, selection), ...Object.fromEntries(parents.map(id => [`needs.${id}.result`, results[id]])) };
  const result = ciExpression(expression, inputs);
  if (typeof result !== "boolean") throw new Error("Expected job admission boolean");
  return result;
}

function graph(input: Scenario, selection: Selection, failed = ""): Record<string, { result: Result; outputs: Record<string, string> }> {
  const results: Record<string, Result> = {};
  const summary: Record<string, { result: Result; outputs: Record<string, string> }> = {};
  for (const [id, value] of Object.entries(jobs)) {
    if (id === "ci-result" || id === "update-status") continue;
    const run = admitted(record(value), input, selection, results);
    const result = run ? id === failed || (id === "quality" && input.draft) ? "failure" : "success" : "skipped";
    results[id] = result;
    summary[id] = { result, outputs: id === "quality" ? { rust: String(selection.rust), shared: String(selection.shared), "shared-native": String(selection.native) } : {} };
  }
  return summary;
}

test("one existing job per check retains the dependency graph and every blocker", () => {
  expect(Object.keys(jobs).sort()).toEqual(routed.concat(light).sort());
  expect(Object.keys(warmJobs).sort()).toEqual(["identity", "jsc-prebuild", "shared-identity", "shared-prebuild"]);
  expect(record(jobs.rust).needs).toEqual(["quality", "jsc-prebuild", "native-quality"]);
  expect(record(jobs["shared-sysroot"]).needs).toEqual(["quality", "rust", "shared-prebuild", "shared-spidermonkey-prebuild"]);
  expect(record(jobs["browser-process"]).needs).toEqual(["quality", "rust", "process-bundles", "browser-guest"]);
  expect(dependencies(record(jobs["ci-result"])).toSorted()).toEqual(Object.keys(jobs).filter(id => id !== "ci-result" && id !== "update-status").sort());
  for (const value of Object.values(jobs).concat(Object.values(warmJobs))) expect(record(value)).not.toHaveProperty("continue-on-error");
  expect(record(workflow.on)).not.toHaveProperty("pull_request_target");
  expect(record(warm.on)).toEqual({ push: { branches: ["main"] } });
  for (const name of ["ci.yml", "jsc-prebuild.yml"]) {
    const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    expect(Array.from(source.matchAll(/runs-on: &pc-runner /g))).toHaveLength(1);
    expect(source).toContain("runs-on: *pc-runner");
  }
  const policy = record(jobs["jsc-identity"])["runs-on"];
  for (const id of routed) expect(record(jobs[id])["runs-on"]).toBe(policy);
  for (const job of Object.values(warmJobs)) expect(record(job)["runs-on"]).toBe(policy);
});

const events = [
  { event: "pull_request", ref: "refs/pull/1/merge", repository: "ShaulLavo/bun-wasm", pc: true },
  { event: "pull_request", ref: "refs/pull/1/merge", repository: "fork/bun-wasm", pc: false },
  { event: "push", ref: "refs/heads/main", repository: "", pc: true },
  { event: "push", ref: "refs/heads/feature", repository: "", pc: false },
  { event: "workflow_dispatch", ref: "refs/heads/main", repository: "", pc: false },
  { event: "workflow_dispatch", ref: "refs/heads/feature", repository: "ShaulLavo/bun-wasm", pc: false },
];

for (const event of events) test(`scheduler routes ${event.event} ${event.ref} ${event.repository || "without PR"} before allocation`, () => {
  for (const enabled of ["", "false", "true", "1"]) {
    const input = { ...scenario, ...event, enabled };
    const labels = enabled === "true" && event.pc ? pcLabels : ["ubuntu-latest"];
    for (const id of routed) {
      const job = record(jobs[id]);
      expect(job.if, id).toContain(trust);
      expect(ciRunner(job["runs-on"], values(input)), id).toEqual(labels);
      expect(admitted(job, input, selected, Object.fromEntries(dependencies(job).map(id => [id, "success"]))), id).toBe(true);
    }
    for (const id of light) expect(ciRunner(record(jobs[id])["runs-on"], values(input)), id).toEqual(["ubuntu-latest"]);
    for (const value of Object.values(warmJobs)) {
      expect(record(value).if).toContain(trust);
      expect(ciRunner(record(value)["runs-on"], values(input))).toEqual(labels);
    }
  }
});

const selections = [false, true].flatMap(rust => [false, true].flatMap(shared => [false, true].map(native => ({ rust, shared, native }))));
test("forks keep equivalent blocking checks for all eight source selections with the switch on or off", () => {
  for (const selection of selections) {
    const trusted = graph(scenario, selection);
    expect(() => requireCiSuccess(trusted)).not.toThrow();
    for (const enabled of ["", "true"]) {
      const fork = graph({ ...scenario, enabled, repository: "fork/bun-wasm" }, selection);
      expect(fork).toEqual(trusted);
      expect(() => requireCiSuccess(fork)).not.toThrow();
    }
  }
});

test("fork failures and drafts cannot turn skipped work into a passing aggregate", () => {
  const fork = { ...scenario, repository: "fork/bun-wasm" };
  for (const id of routed) expect(() => requireCiSuccess(graph(fork, selected, id)), id).toThrow();
  expect(() => requireCiSuccess(graph({ ...fork, draft: true }, selected))).toThrow("Source quality");
  for (const id of routed.filter(id => id !== "web")) {
    const job = record(jobs[id]);
    expect(admitted(job, fork, selected, Object.fromEntries(dependencies(job).map(id => [id, "success"])), true)).toBe(false);
  }
});
