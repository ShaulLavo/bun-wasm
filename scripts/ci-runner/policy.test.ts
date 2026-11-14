import { expect, test } from "bun:test";
import { approveAssignedJob, eligibleQueuedJob, type GitHubApi, type Session } from "./policy.ts";

function fixture() {
  const session: Session = { jobId: 101, runId: 202, attempt: 3, runnerId: 303, headSha: "a".repeat(40) };
  const job = { id: 101, run_id: 202, run_attempt: 3, head_sha: session.headSha, status: "in_progress", runner_id: 303, labels: ["self-hosted", "linux", "x64", "pc", "bun-wasm"] };
  const repo = { full_name: "ShaulLavo/bun-wasm" };
  const run = { id: 202, run_attempt: 3, event: "pull_request", head_sha: session.headSha, head_branch: "feature", status: "in_progress", conclusion: null, repository: repo, head_repository: repo, pull_requests: [{ number: 404 }] };
  const pr = { state: "open", head: { repo, sha: session.headSha }, base: { repo } };
  const ref = { object: { sha: session.headSha } };
  const api: GitHubApi = async path => {
    if (path.endsWith("/actions/jobs/101")) return job;
    if (path.endsWith("/actions/runs/202")) return run;
    if (path.endsWith("/pulls/404")) return pr;
    if (path.endsWith("/git/ref/heads/main")) return ref;
    throw new Error("Unexpected API lookup");
  };
  return { session, job, run, pr, ref, api };
}

test("current API assignment to this registered runner is approved", async () => {
  const f = fixture();
  await approveAssignedJob(f.api, f.session);
});

test("allocation requires a server-validated queued job", async () => {
  const f = fixture();
  await expect(eligibleQueuedJob(f.api, 101)).rejects.toThrow();
  f.job.status = "queued";
  f.job.runner_id = 0;
  expect(await eligibleQueuedJob(f.api, 101)).toEqual({ jobId: 101, runId: 202, attempt: 3, headSha: "a".repeat(40) });
});

test.each(["pending", "queued"])("workflow %s does not hide the current job assignment", async status => {
  const f = fixture();
  f.run.status = status;
  f.job.status = "queued";
  f.job.runner_id = 0;
  expect(await eligibleQueuedJob(f.api, f.session.jobId)).toEqual({ jobId: 101, runId: 202, attempt: 3, headSha: f.session.headSha });
  f.job.status = "in_progress";
  f.job.runner_id = f.session.runnerId;
  await approveAssignedJob(f.api, f.session);
});

test("fork YAML cannot forge the target registered-runner binding", async () => {
  const f = fixture();
  f.job.runner_id = 999;
  await expect(approveAssignedJob(f.api, f.session)).rejects.toThrow();
  f.job.runner_id = f.session.runnerId;
  f.run.head_repository = { full_name: "fork/bun-wasm" };
  await expect(approveAssignedJob(f.api, f.session)).rejects.toThrow();
});

test("actual PR head and base repositories are independently checked", async () => {
  const f = fixture();
  f.pr.head.repo = { full_name: "fork/bun-wasm" };
  await expect(approveAssignedJob(f.api, f.session)).rejects.toThrow();
});

for (const changed of ["attempt", "cancel", "stale-head", "event", "pool"]) test(`rejects ${changed} before approval`, async () => {
  const f = fixture();
  if (changed === "attempt") f.run.run_attempt++;
  if (changed === "cancel") f.run.status = "completed";
  if (changed === "stale-head") f.pr.head.sha = "b".repeat(40);
  if (changed === "event") f.run.event = "workflow_dispatch";
  if (changed === "pool") f.job.labels = ["bun-wasm"];
  await expect(approveAssignedJob(f.api, f.session)).rejects.toThrow();
});

test("current main push must still match server main ref", async () => {
  const f = fixture();
  f.run.event = "push";
  f.run.head_branch = "main";
  await approveAssignedJob(f.api, f.session);
  f.ref.object.sha = "b".repeat(40);
  await expect(approveAssignedJob(f.api, f.session)).rejects.toThrow();
});

test("API uncertainty and cancellation during verification reject", async () => {
  const f = fixture();
  await expect(approveAssignedJob(async () => { throw new Error("offline"); }, f.session)).rejects.toThrow();
  let calls = 0;
  await expect(approveAssignedJob(async path => {
    calls++;
    if (calls === 4) f.job.status = "completed";
    return f.api(path);
  }, f.session)).rejects.toThrow();
});
