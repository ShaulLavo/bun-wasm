import { expect, test } from "bun:test";
import { approveAssignedJob, eligibleQueuedJob, type GitHubApi, type Session } from "./policy.ts";

function fixture() {
  const session: Session = { runnerId: 303 };
  const hint = { runId: 202, attempt: 3 };
  const job = { id: 102, run_id: 202, run_attempt: 3, head_sha: "a".repeat(40), status: "in_progress", conclusion: null, runner_id: 303, labels: ["self-hosted", "linux", "x64", "pc", "bun-wasm"] };
  const candidate = { ...job, id: 101, status: "queued", runner_id: 0 };
  const jobs = [candidate, job];
  const repo = { full_name: "ShaulLavo/bun-wasm" };
  const run = { id: 202, run_attempt: 3, event: "pull_request", head_sha: job.head_sha, head_branch: "feature", status: "in_progress", conclusion: null, repository: repo, head_repository: repo, pull_requests: [{ number: 404 }] };
  const otherRun = { ...run, id: 505, run_attempt: 1, head_sha: "b".repeat(40), pull_requests: [{ number: 606 }] };
  const pr = { state: "open", head: { repo, sha: job.head_sha }, base: { repo } };
  const otherPr = { ...pr, head: { repo, sha: otherRun.head_sha } };
  const ref = { object: { sha: job.head_sha } };
  const calls: string[] = [];
  const api: GitHubApi = async path => {
    calls.push(path);
    const inventory = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100$/.exec(path);
    if (inventory) {
      const selected = jobs.filter(item => item.run_id === Number(inventory[1]) && item.run_attempt === Number(inventory[2]));
      return structuredClone({ total_count: selected.length, jobs: selected });
    }
    if (path.endsWith(`/actions/jobs/${job.id}`)) return structuredClone(job);
    if (path.endsWith(`/actions/jobs/${candidate.id}`)) return structuredClone(candidate);
    if (path.endsWith("/actions/runs/202")) return structuredClone(run);
    if (path.endsWith("/actions/runs/505")) return structuredClone(otherRun);
    if (path.endsWith("/pulls/404")) return structuredClone(pr);
    if (path.endsWith("/pulls/606")) return structuredClone(otherPr);
    if (path.endsWith("/git/ref/heads/main")) return structuredClone(ref);
    throw new Error("Unexpected API lookup");
  };
  return { session, hint, candidate, job, jobs, run, otherRun, pr, otherPr, ref, api, calls };
}

test("two eligible queued jobs do not reserve assignment order", async () => {
  const f = fixture();
  f.job.status = "queued";
  f.job.runner_id = 0;
  const admission = await eligibleQueuedJob(f.api, f.candidate.id);
  await eligibleQueuedJob(f.api, f.job.id);
  f.job.status = "in_progress";
  f.job.runner_id = f.session.runnerId;
  expect(await approveAssignedJob(f.api, f.session, f.hint)).toEqual({ ...admission, jobId: 102, runnerId: 303 });
  expect(f.candidate.status).toBe("queued");
});

test("actual assignment may belong to another current trusted run", async () => {
  const f = fixture();
  const admission = await eligibleQueuedJob(f.api, f.candidate.id);
  f.job.run_id = f.otherRun.id;
  f.job.run_attempt = f.otherRun.run_attempt;
  f.job.head_sha = f.otherRun.head_sha;
  const assignment = await approveAssignedJob(f.api, f.session, { runId: 505, attempt: 1 });
  expect(assignment).toEqual({ jobId: 102, runId: 505, attempt: 1, headSha: f.otherRun.head_sha, runnerId: 303 });
  expect(assignment.runId).not.toBe(admission.runId);
  expect(f.calls.filter(path => path.includes("/pulls/606"))).toHaveLength(2);
});

test("candidate hints cannot approve an assignment in another run", async () => {
  const f = fixture();
  f.job.run_id = 505;
  f.job.run_attempt = 1;
  f.job.head_sha = f.otherRun.head_sha;
  await expect(approveAssignedJob(f.api, f.session, f.hint)).rejects.toThrow();
});

test("allocation requires a server-validated queued unassigned job", async () => {
  const f = fixture();
  await expect(eligibleQueuedJob(f.api, f.job.id)).rejects.toThrow();
  expect(await eligibleQueuedJob(f.api, f.candidate.id)).toEqual({ jobId: 101, runId: 202, attempt: 3, headSha: f.run.head_sha });
  f.candidate.runner_id = 999;
  await expect(eligibleQueuedJob(f.api, f.candidate.id)).rejects.toThrow();
});

test.each(["pending", "queued"])("workflow %s does not hide a current job assignment", async status => {
  const f = fixture();
  f.run.status = status;
  await eligibleQueuedJob(f.api, f.candidate.id);
  await approveAssignedJob(f.api, f.session, f.hint);
});

for (const changed of ["wrong-runner", "fork-run", "fork-pr-head", "fork-pr-base", "repository", "attempt", "cancel", "conclusion", "stale-head", "event", "non-main-push", "pool", "queued", "completed", "job-conclusion"]) test(`rejects ${changed} before approval`, async () => {
  const f = fixture();
  if (changed === "wrong-runner") f.job.runner_id = 999;
  if (changed === "fork-run") f.run.head_repository = { full_name: "fork/bun-wasm" };
  if (changed === "fork-pr-head") f.pr.head.repo = { full_name: "fork/bun-wasm" };
  if (changed === "fork-pr-base") f.pr.base.repo = { full_name: "fork/bun-wasm" };
  if (changed === "repository") f.run.repository = { full_name: "other/repo" };
  if (changed === "attempt") f.run.run_attempt++;
  if (changed === "cancel") f.run.status = "completed";
  if (changed === "conclusion") Object.assign(f.run, { conclusion: "cancelled" });
  if (changed === "stale-head") f.pr.head.sha = "b".repeat(40);
  if (changed === "event") f.run.event = "workflow_dispatch";
  if (changed === "non-main-push") f.run.event = "push";
  if (changed === "pool") f.job.labels = ["bun-wasm"];
  if (changed === "queued") f.job.status = "queued";
  if (changed === "completed") f.job.status = "completed";
  if (changed === "job-conclusion") Object.assign(f.job, { conclusion: "cancelled" });
  await expect(approveAssignedJob(f.api, f.session, f.hint)).rejects.toThrow();
});

test.each(["fork", "manual", "non-main", "stale", "cancelled"])("preallocation still rejects %s", async changed => {
  const f = fixture();
  if (changed === "fork") f.run.head_repository = { full_name: "fork/bun-wasm" };
  if (changed === "manual") f.run.event = "workflow_dispatch";
  if (changed === "non-main") f.run.event = "push";
  if (changed === "stale") f.pr.head.sha = "b".repeat(40);
  if (changed === "cancelled") f.run.status = "completed";
  await expect(eligibleQueuedJob(f.api, f.candidate.id)).rejects.toThrow();
});

test("current main push must still match server main ref", async () => {
  const f = fixture();
  f.run.event = "push";
  f.run.head_branch = "main";
  await approveAssignedJob(f.api, f.session, f.hint);
  f.ref.object.sha = "b".repeat(40);
  await expect(approveAssignedJob(f.api, f.session, f.hint)).rejects.toThrow();
});

test.each([
  null, {}, { jobs: [], total_count: 1 }, { jobs: [], total_count: "0" },
  { jobs: [], total_count: 101 }, { jobs: [], total_count: 0.5 },
])("incomplete or malformed inventories reject: %j", async inventory => {
  const f = fixture();
  const api: GitHubApi = async path => path.includes("/attempts/") ? inventory : f.api(path);
  await expect(approveAssignedJob(api, f.session, f.hint)).rejects.toThrow();
});

test.each(["duplicate", "ambiguous", "truncated", "over-limit", "run", "attempt", "runner", "status"])("inventory rejects %s", async changed => {
  const f = fixture();
  let jobs: unknown[] = f.jobs;
  if (changed === "duplicate") jobs = [f.job, f.job];
  if (changed === "ambiguous") f.candidate.runner_id = f.session.runnerId;
  if (changed === "over-limit") jobs = Array.from({ length: 101 }, (_, index) => ({ ...f.candidate, id: index + 1000 })).concat([f.job]);
  if (changed === "run") f.candidate.run_id++;
  if (changed === "attempt") f.candidate.run_attempt++;
  if (changed === "runner") Object.assign(f.candidate, { runner_id: undefined });
  if (changed === "status") Object.assign(f.candidate, { status: undefined });
  const inventory = { total_count: jobs.length + (changed === "truncated" ? 1 : 0), jobs };
  const api: GitHubApi = async path => path.includes("/attempts/") ? inventory : f.api(path);
  await expect(approveAssignedJob(api, f.session, f.hint)).rejects.toThrow();
});

test.each(["runner", "cancel", "attempt", "head", "trust", "inventory", "replacement"])("fresh release recheck rejects changed %s", async changed => {
  const f = fixture();
  let inventories = 0;
  let exactJobs = 0;
  const api: GitHubApi = async path => {
    if (path.includes("/attempts/")) inventories++;
    if (path.endsWith("/actions/jobs/102")) exactJobs++;
    if (inventories === 2 && changed === "inventory") f.candidate.runner_id = f.session.runnerId;
    if (inventories === 2 && changed === "replacement") Object.assign(f.candidate, { runner_id: 303, status: "in_progress" });
    if (inventories === 2 && changed === "replacement") f.job.runner_id = 999;
    if (exactJobs === 2 && changed === "runner") f.job.runner_id = 999;
    if (exactJobs === 2 && changed === "cancel") f.run.status = "completed";
    if (exactJobs === 2 && changed === "attempt") f.run.run_attempt++;
    if (exactJobs === 2 && changed === "head") Object.assign(f.job, { head_sha: "b".repeat(40) });
    if (exactJobs === 2 && changed === "head") f.run.head_sha = f.pr.head.sha = f.job.head_sha;
    if (exactJobs === 2 && changed === "trust") f.pr.head.repo = { full_name: "fork/bun-wasm" };
    return f.api(path);
  };
  await expect(approveAssignedJob(api, f.session, f.hint)).rejects.toThrow();
});

test("fresh release recheck rejects main ref movement", async () => {
  const f = fixture();
  f.run.event = "push";
  f.run.head_branch = "main";
  let refs = 0;
  const api: GitHubApi = async path => {
    if (path.endsWith("/git/ref/heads/main") && ++refs === 2) f.ref.object.sha = "b".repeat(40);
    return f.api(path);
  };
  await expect(approveAssignedJob(api, f.session, f.hint)).rejects.toThrow();
});

test("lookup is bounded and API uncertainty rejects", async () => {
  const f = fixture();
  await approveAssignedJob(f.api, f.session, f.hint);
  expect(f.calls).toHaveLength(8);
  await expect(approveAssignedJob(async () => { throw new Error("offline"); }, f.session, f.hint)).rejects.toThrow();
});
