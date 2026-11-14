export type GitHubApi = (path: string) => Promise<unknown>;
export type Admission = { jobId: number; runId: number; attempt: number; headSha: string };
export type Session = Admission & { runnerId: number };
export const repository = "ShaulLavo/bun-wasm";
export const activeRunStatuses = ["in_progress", "queued", "pending"] as const;
const endpoint = `/repos/${repository}`;

function activeRun(run: Record<string, unknown>): boolean {
  return run.conclusion === null && activeRunStatuses.some(status => run.status === status);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid GitHub API object");
  return value as Record<string, unknown>;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid GitHub API identity");
  return value;
}

async function trustedRun(api: GitHubApi, run: Record<string, unknown>): Promise<void> {
  if (record(run.repository).full_name !== repository || record(run.head_repository).full_name !== repository) throw new Error("Run repository is not trusted");
  if (typeof run.head_sha !== "string" || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Invalid run head");
  if (run.event === "push" && run.head_branch === "main") {
    const ref = record(await api(`${endpoint}/git/ref/heads/main`));
    if (record(ref.object).sha !== run.head_sha) throw new Error("Main push is stale");
    return;
  }
  if (run.event !== "pull_request" || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) throw new Error("Run event is not eligible");
  const number = positive(record(run.pull_requests[0]).number);
  const pr = record(await api(`${endpoint}/pulls/${number}`));
  const head = record(pr.head);
  if (pr.state !== "open" || record(head.repo).full_name !== repository || record(record(pr.base).repo).full_name !== repository || head.sha !== run.head_sha) throw new Error("PR source is not current and trusted");
}

async function facts(api: GitHubApi, jobId: number) {
  positive(jobId);
  const job = record(await api(`${endpoint}/actions/jobs/${jobId}`));
  const runId = positive(job.run_id);
  const run = record(await api(`${endpoint}/actions/runs/${runId}`));
  if (job.id !== jobId || run.id !== runId || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha || !activeRun(run)) throw new Error("Job/run binding is stale");
  const labels = job.labels;
  if (!Array.isArray(labels) || !["self-hosted", "linux", "x64", "pc", "bun-wasm"].every(label => labels.includes(label))) throw new Error("Job does not target this PC pool");
  await trustedRun(api, run);
  return { job, admission: { jobId, runId, attempt: positive(run.run_attempt), headSha: String(run.head_sha) } };
}

export async function eligibleQueuedJob(api: GitHubApi, jobId: number): Promise<Admission> {
  const { job, admission } = await facts(api, jobId);
  if (job.status !== "queued" || (job.runner_id !== 0 && job.runner_id !== null)) throw new Error("Job is no longer queued");
  return admission;
}

export async function approveAssignedJob(api: GitHubApi, session: Session): Promise<void> {
  positive(session.runnerId);
  const { job, admission } = await facts(api, session.jobId);
  if (admission.runId !== session.runId || admission.attempt !== session.attempt || admission.headSha !== session.headSha || job.runner_id !== session.runnerId || job.status !== "in_progress") throw new Error("Assigned job is not bound to this VM session");
  const latestJob = record(await api(`${endpoint}/actions/jobs/${session.jobId}`));
  const latestRun = record(await api(`${endpoint}/actions/runs/${session.runId}`));
  if (latestJob.id !== session.jobId || latestJob.run_id !== session.runId || latestJob.head_sha !== session.headSha || latestJob.runner_id !== session.runnerId || latestJob.status !== "in_progress" || latestJob.run_attempt !== session.attempt || latestRun.id !== session.runId || latestRun.head_sha !== session.headSha || latestRun.run_attempt !== session.attempt || !activeRun(latestRun)) throw new Error("Job changed before approval");
  await trustedRun(api, latestRun);
}
