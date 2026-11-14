import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireCiSuccess } from "./ci-result";
import { selectChecks } from "./test-checks";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = object(workflow.jobs);
const selector = object(jobs.selection);

function steps(job: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) throw new Error("Expected workflow steps");
  return job.steps.map(object);
}

const selectionStep = steps(selector).find(step => step.id === "changes");
if (!selectionStep || typeof selectionStep.run !== "string") throw new Error("Missing workflow selector");
const selectionShell = selectionStep.run;
const all = { rust: "true", jsc: "true", shared: "true", shared_native: "true" };
const none = { rust: "false", jsc: "false", shared: "false", shared_native: "false" };

function scratch(body: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-main-artifacts-"));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function select(directory: string, event: string, base = "unused", head = "unused", ref = "refs/heads/main") {
  const output = join(directory, "selection-output");
  writeFileSync(output, "");
  execFileSync("bash", ["-euo", "pipefail", "-c", selectionShell], {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_TOKEN: "", GITHUB_OUTPUT: output, BASE: base, HEAD: head },
  });
  return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => line.split("=")));
}

function git(directory: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=CI artifact test", "-c", "user.email=ci@localhost"].concat(args), {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(directory: string, path: string): string {
  mkdirSync(join(directory, path, ".."), { recursive: true });
  writeFileSync(join(directory, path), path);
  git(directory, ["add", path]);
  git(directory, ["commit", "-qm", path]);
  return git(directory, ["rev-parse", "HEAD"]);
}

test("every main push selects the complete artifact set without history, credentials or comparison refs", () => scratch(directory => {
  expect(select(directory, "push")).toEqual(all);
  expect(selector.permissions).toEqual({ contents: "read" });
  expect(steps(selector).find(step => step.id === "refs")?.run).toBe('bun scripts/ci-refs.ts >> "$GITHUB_OUTPUT"');
  expect(selectionStep.env).toEqual({ BASE: "${{ steps.refs.outputs.base }}", HEAD: "${{ steps.refs.outputs.head }}" });
  expect(selectionShell).toContain('bun scripts/ci-changes.ts "$BASE" "$HEAD"');
  expect(selectChecks("quality")).toContain("scripts/ci-main-artifacts.test.ts");
}));

test("docs replacements keep all main exports while PR and manual runs retain path selection", () => scratch(directory => {
  git(directory, ["init", "-q"]);
  const base = commit(directory, "docs/base.md");
  const native = commit(directory, "jsc/changed.c");
  const docs = commit(directory, "docs/after-native.md");
  symlinkSync(resolve(import.meta.dir), join(directory, "scripts"), "dir");
  expect(select(directory, "push", native, docs)).toEqual(all);
  for (const event of ["pull_request", "workflow_dispatch"]) {
    expect(select(directory, event, base, native), event).toEqual({ ...none, rust: "true", jsc: "true" });
    expect(select(directory, event, native, docs), event).toEqual(none);
  }
  expect(select(directory, "push", native, docs, "refs/heads/other")).toEqual(none);
}));

interface ConditionContext {
  event?: string;
  ref?: string;
  fork?: boolean;
  cancelled?: boolean;
  results?: Record<string, string>;
}

function admitted(condition: unknown, outputs: Record<string, string>, context: ConditionContext = {}): boolean {
  const success = !context.cancelled && Object.values(context.results ?? {}).every(result => result === "success");
  if (condition === undefined) return success;
  if (typeof condition !== "string") throw new Error("Expected workflow condition");
  if (!/\b(?:always|cancelled|success|failure)\(\)/.test(condition) && !success) return false;
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.event.pull_request.head.repo.full_name", JSON.stringify(context.fork ? "outside/bun-wasm" : "ShaulLavo/bun-wasm"))
    .replaceAll("github.repository", JSON.stringify("ShaulLavo/bun-wasm"))
    .replaceAll("github.event_name", JSON.stringify(context.event ?? "push")).replaceAll("github.event.pull_request.draft", "false")
    .replaceAll("github.ref", JSON.stringify(context.ref ?? "refs/heads/main"))
    .replace(/needs\.[\w-]+\.outputs\.([\w-]+)/g, (_match, flag: string) => JSON.stringify(outputs[flag]))
    .replace(/needs\.([\w-]+)\.result/g, (_match, id: string) => JSON.stringify(context.results?.[id] ?? "success"))
    .replace(/steps\.[\w-]+\.outcome/g, '"success"')
    .replaceAll("cancelled()", String(context.cancelled ?? false)).replaceAll("always()", "true");
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Expected boolean workflow admission");
  return result;
}

function dependencies(job: Record<string, unknown>): string[] {
  if (job.needs === undefined) return [];
  if (typeof job.needs === "string") return [job.needs];
  if (!Array.isArray(job.needs) || !job.needs.every(id => typeof id === "string")) throw new Error("Expected job dependencies");
  return job.needs;
}

function requireProducer(id: string, outputs: Record<string, string>, visited = new Set<string>()): void {
  if (visited.has(id)) return;
  visited.add(id);
  const job = object(jobs[id]);
  expect(admitted(job.if, outputs), id).toBe(true);
  expect(job["continue-on-error"], id).toBeUndefined();
  for (const dependency of dependencies(job)) requireProducer(dependency, outputs, visited);
}

const artifacts = [
  { job: "rust", name: "browser-program", producer: "Export the validated standard Browser and tools guests" },
  { job: "rust", name: "browser-guest-site", producer: "Build the browser-guest site once" },
  { job: "rust", name: "native-profile-launcher", producer: "Package the native profile launcher" },
  { job: "rust", name: "ordinary-jsc-program", producer: "Export the validated ordinary JSC pair" },
  { job: "rust", name: "ordinary-spidermonkey-program", producer: "Export the live-gated ordinary SpiderMonkey pair" },
  { job: "shared-sysroot", name: "shared-quickjs-program", producer: "Produce the shared native profile once" },
  { job: "shared-sysroot", name: "shared-jsc-program", producer: "Produce the shared JSC profile once" },
  { job: "shared-sysroot", name: "shared-spidermonkey-program", producer: "Produce the shared SpiderMonkey profile once" },
];

test.each(artifacts)("green main includes $name through its actual producer and upload conditions", ({ job, name, producer }) => scratch(directory => {
  const selected = select(directory, "push");
  const outputs = { ...selected, "shared-native": selected.shared_native };
  requireProducer(job, outputs);
  const jobSteps = steps(object(jobs[job]));
  const produce = jobSteps.findIndex(step => step.name === producer);
  const upload = jobSteps.findIndex(step => String(step.uses).startsWith("actions/upload-artifact@") && object(step.with).name === name);
  expect(produce, producer).toBeGreaterThanOrEqual(0);
  expect(upload, name).toBeGreaterThan(produce);
  const transfer = jobSteps[upload]!;
  expect(object(transfer.with)["if-no-files-found"]).toBe("error");
  for (const step of [jobSteps[produce]!, transfer]) {
    expect(admitted(step.if, outputs), String(step.name ?? name)).toBe(true);
    expect(step["continue-on-error"]).toBeUndefined();
  }
}));

test.each(["failure", "cancelled", "skipped"])("the final main gate rejects %s from every artifact prerequisite", result => scratch(directory => {
  const selected = select(directory, "push");
  const outputs = { ...selected, "shared-native": selected.shared_native };
  const required = dependencies(object(jobs["ci-result"]));
  const results = Object.fromEntries(required.map(id => [id, { result: "success", outputs }]));
  expect(() => requireCiSuccess(results)).not.toThrow();
  for (const id of required) {
    expect(() => requireCiSuccess({ ...results, [id]: { result, outputs } }), `${id}: ${result}`).toThrow();
  }
  expect(object(jobs["ci-result"]).if).toContain("always()");
}));

test("explicit main cancellation stops every job, including always-guarded aggregates", () => {
  const outputs = { ...all, "shared-native": "true" };
  for (const [id, value] of Object.entries(jobs)) {
    expect(admitted(object(value).if, outputs, { cancelled: true }), id).toBe(false);
  }
});

test("main failures still reach blocking aggregates and PR/manual cancellation guards keep their behavior", () => {
  const outputs = { ...all, "shared-native": "true" };
  const web = object(jobs.web);
  const gate = object(jobs["ci-result"]);
  const processes = object(jobs["browser-process"]);
  for (const event of ["push", "pull_request", "workflow_dispatch"]) {
    expect(admitted(web.if, outputs, { event, results: { "web-unit": "failure" } }), event).toBe(true);
    expect(admitted(gate.if, outputs, { event, results: { rust: "failure" } }), event).toBe(true);
    expect(admitted(gate.if, outputs, { event, results: { quality: "failure" } }), event).toBe(true);
    expect(admitted(processes.if, outputs, { event, results: { "browser-guest": "failure" } }), event).toBe(true);
  }
  for (const event of ["pull_request", "workflow_dispatch"]) {
    expect(admitted(web.if, outputs, { event, cancelled: true }), event).toBe(true);
    expect(admitted(gate.if, outputs, { event, cancelled: true }), event).toBe(true);
    expect(admitted(processes.if, outputs, { event, cancelled: true }), event).toBe(false);
  }
});
