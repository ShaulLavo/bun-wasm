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

test("no job runs on Boat runners", () => {
  const formerBoatJobs = ["jsc-prebuild", "native-quality", "rust", "package", "shared-sysroot", "web", "browser-process"];
  for (const id of formerBoatJobs) expect(record(jobs[id])["runs-on"], id).toBe("ubuntu-latest");
  const boatJobs = Object.entries(jobs).filter(([, value]) => JSON.stringify(record(value)["runs-on"]).includes("boat"));
  expect(boatJobs.map(([id]) => id)).toEqual([]);
});
