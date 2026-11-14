export type GitHubApi = (path: string) => Promise<unknown>;
export type Admission = { jobId: number; runId: number; attempt: number; headSha: string };
export type Session = { runnerId: number };
export type AssignmentHint = { runId: number; attempt: number };
export type Assignment = Admission & Session;
export const repository = "ShaulLavo/bun-wasm";
export const activeRunStatuses = ["in_progress", "queued", "pending"] as const;
const endpoint = `/repos/${repository}`;

export function targetsPcPool(labels: unknown): boolean {
  return Array.isArray(labels) && ["self-hosted", "linux", "x64", "pc", "bun-wasm"].every(label => labels.includes(label));
}

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
  if (!targetsPcPool(job.labels)) throw new Error("Job does not target this PC pool");
  await trustedRun(api, run);
  return { job, admission: { jobId, runId, attempt: positive(run.run_attempt), headSha: String(run.head_sha) } };
}

export async function eligibleQueuedJob(api: GitHubApi, jobId: number): Promise<Admission> {
  const { job, admission } = await facts(api, jobId);
  if (job.status !== "queued" || (job.runner_id !== 0 && job.runner_id !== null)) throw new Error("Job is no longer queued");
  return admission;
}

async function assignedJobId(api: GitHubApi, session: Session, hint: AssignmentHint): Promise<number> {
  const result = record(await api(`${endpoint}/actions/runs/${hint.runId}/attempts/${hint.attempt}/jobs?per_page=100`));
  if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count !== result.jobs.length || result.jobs.length > 100) throw new Error("Assignment inventory is incomplete");
  const jobs = result.jobs.map(record);
  const ids = new Set<number>();
  for (const job of jobs) {
    const id = positive(job.id);
    if (ids.has(id) || job.run_id !== hint.runId || job.run_attempt !== hint.attempt || typeof job.status !== "string") throw new Error("Invalid assignment inventory");
    if (job.runner_id !== null && (typeof job.runner_id !== "number" || !Number.isSafeInteger(job.runner_id) || job.runner_id < 0)) throw new Error("Invalid assignment runner");
    ids.add(id);
  }
  const matches = jobs.filter(job => job.runner_id === session.runnerId);
  const job = matches[0];
  if (matches.length !== 1 || !job || job.status !== "in_progress") throw new Error("Assignment to this registered runner is not unique and active");
  return positive(job.id);
}

async function assignedFacts(api: GitHubApi, session: Session, hint: AssignmentHint, jobId: number): Promise<Assignment> {
  const { job, admission } = await facts(api, jobId);
  if (admission.runId !== hint.runId || admission.attempt !== hint.attempt || job.runner_id !== session.runnerId || job.status !== "in_progress" || job.conclusion !== null) throw new Error("Assigned job is not bound to this VM session");
  return { ...admission, runnerId: session.runnerId };
}

export async function approveAssignedJob(api: GitHubApi, session: Session, hint: AssignmentHint): Promise<Assignment> {
  positive(session.runnerId);
  positive(hint.runId);
  positive(hint.attempt);
  const jobId = await assignedJobId(api, session, hint);
  const assignment = await assignedFacts(api, session, hint, jobId);
  if (await assignedJobId(api, session, hint) !== jobId) throw new Error("Assignment changed before approval");
  const latest = await assignedFacts(api, session, hint, jobId);
  if (latest.headSha !== assignment.headSha) throw new Error("Job changed before approval");
  return latest;
}
