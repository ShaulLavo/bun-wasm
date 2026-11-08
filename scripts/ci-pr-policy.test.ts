import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const workflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = record(workflow.jobs);

function admitted(job: Record<string, unknown>, event: string, draft: boolean, ref = "refs/heads/main"): boolean {
  if (typeof job.if !== "string") return true;
  const expression = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.event_name", JSON.stringify(event))
    .replaceAll("github.event.pull_request.draft", String(draft))
    .replaceAll("!cancelled()", "true")
    .replaceAll("always()", "true")
    .replaceAll("github.ref", JSON.stringify(ref))
    .replace(/needs\.[\w-]+\.outputs\.[\w-]+/g, '"true"')
    .replace(/needs\.[\w-]+\.result/g, '"success"');
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Expected boolean admission");
  return result;
}

test("draft PRs defer native and browser work until ready without changing push or manual checks", () => {
  const events = record(workflow.on);
  expect(record(events.pull_request).types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  for (const [id, value] of Object.entries(jobs)) {
    if (id === "update-status") continue;
    const job = record(value);
    expect(admitted(job, "pull_request", true), id).toBe(id === "quality");
    expect(admitted(job, "pull_request", false), id).toBe(true);
    expect(admitted(job, "push", false), id).toBe(true);
    expect(admitted(job, "workflow_dispatch", false), id).toBe(true);
  }
});

test("only PR updates cancel older runs and each non-PR run has a separate group", () => {
  expect(record(workflow.concurrency)).toEqual({
    group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});

test("update statuses run only for manual checks of the standing update branch", () => {
  const reporter = record(jobs["update-status"]);
  const branch = "refs/heads/automation/owned-dependency-updates";
  expect(admitted(reporter, "pull_request", true, branch)).toBe(false);
  expect(admitted(reporter, "pull_request", false, branch)).toBe(false);
  expect(admitted(reporter, "push", false, branch)).toBe(false);
  expect(admitted(reporter, "workflow_dispatch", false)).toBe(false);
  expect(admitted(reporter, "workflow_dispatch", false, branch)).toBe(true);
  expect(reporter.needs).toEqual(Object.keys(jobs).filter(id => id !== "update-status"));
  expect(record(reporter.permissions)).toEqual({ statuses: "write" });
});

function selectedRunner(job: Record<string, unknown>, actor: string): string {
  const configured = job["runs-on"];
  if (typeof configured !== "string") throw new Error("Expected a runner label");
  if (!configured.startsWith("${{")) return configured;
  const expression = configured.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.actor", JSON.stringify(actor));
  const runner: unknown = new Function(`return (${expression})`)();
  if (typeof runner !== "string") throw new Error("Expected a selected runner label");
  return runner;
}

test("only the built-in Actions bot routes Boat jobs to hosted runners", () => {
  const original: Record<string, string> = {
    "jsc-prebuild": "boat-large",
    "native-quality": "boat-large",
    rust: "boat-large",
    package: "boat",
    "shared-sysroot": "boat-large",
    web: "boat",
    "browser-process": "boat",
  };
  const routed = Object.entries(jobs).filter(([, value]) => {
    const runner = record(value)["runs-on"];
    return typeof runner === "string" && runner.includes("boat");
  });
  expect(routed.map(([id]) => id).toSorted()).toEqual(Object.keys(original).toSorted());
  for (const [id, value] of routed) {
    const job = record(value);
    expect(job["runs-on"], id).toBe(`\${{ github.actor == 'github-actions[bot]' && 'ubuntu-latest' || '${original[id]}' }}`);
    expect(selectedRunner(job, "github-actions[bot]"), id).toBe("ubuntu-latest");
    for (const actor of ["ShaulLavo", "contributor", "dependabot[bot]", "github-actions[bot]-other", ""]) {
      expect(selectedRunner(job, actor), `${id}/${actor}`).toBe(original[id]);
    }
  }
});
