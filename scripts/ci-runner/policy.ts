export type GitHubApi = (path: string) => Promise<unknown>;
export type Admission = { jobId: number; runId: number; attempt: number; headSha: string };
export type Session = { runnerId: number };
export type AssignmentHint = { runId: number; attempt: number };
export type Assignment = Admission & Session;
export const repository = "ShaulLavo/bun-wasm";
export const activeRunStatuses = ["in_progress", "queued", "pending"] as const;
const endpoint = `/repos/${repository}`;

const denialMessages = {
  "invalid-object": "Invalid GitHub API object",
  "invalid-identity": "Invalid GitHub API identity",
  "untrusted-run-repository": "Run repository is not trusted",
  "invalid-run-head": "Invalid run head",
  "stale-main": "Main push is stale",
  "ineligible-event": "Run event is not eligible",
  "untrusted-or-stale-pr": "PR source is not current and trusted",
  "stale-job-run": "Job/run binding is stale",
  "wrong-pool": "Job does not target this PC pool",
  "not-queued": "Job is no longer queued",
  "incomplete-inventory": "Assignment inventory is incomplete",
  "invalid-inventory": "Invalid assignment inventory",
  "invalid-inventory-runner": "Invalid assignment runner",
  "assignment-not-unique-active": "Assignment to this registered runner is not unique and active",
  "unbound-assignment": "Assigned job is not bound to this VM session",
  "changed-assignment": "Assignment changed before approval",
  "changed-head": "Job changed before approval",
  "api-unavailable": "GitHub API unavailable",
  "api-request-failed": "GitHub API request failed",
  "api-invalid-response": "Invalid GitHub API response",
  unknown: "Unknown approval failure",
} as const;
type DenialReason = keyof typeof denialMessages;
type Phase = "queued" | "initial" | "fresh";
type Stage = "policy" | `${Phase}-${"inventory" | "facts" | "inventory-api" | "job-api" | "run-api" | "pr-api" | "main-ref-api"}` | "fresh-assignment" | "fresh-head";
class PolicyError extends Error {
  readonly #reason: DenialReason;
  readonly #stage: Stage;
  constructor(reason: DenialReason, stage: Stage = "policy") {
    super(denialMessages[reason]);
    this.#reason = reason;
    this.#stage = stage;
  }
  static evidence(error: unknown): { reason: DenialReason; stage: Stage } {
    if (typeof error === "object" && error !== null && #reason in error) return { reason: error.#reason, stage: error.#stage };
    return { reason: "unknown", stage: "policy" };
  }
}

export function apiFailure(reason: "api-unavailable" | "api-request-failed" | "api-invalid-response"): Error {
  return new PolicyError(reason);
}

export function approvalFailure(error: unknown): { reason: DenialReason; stage: Stage } {
  return PolicyError.evidence(error);
}

async function atStage<T>(stage: Stage, check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error) {
    const failure = approvalFailure(error);
    throw new PolicyError(failure.reason, failure.stage === "policy" ? stage : failure.stage);
  }
}

function readApi(api: GitHubApi, path: string, stage: Stage): Promise<unknown> {
  return atStage(stage, () => api(path));
}

export function targetsPcPool(labels: unknown): boolean {
  return Array.isArray(labels) && ["self-hosted", "linux", "x64", "pc", "bun-wasm"].every(label => labels.includes(label));
}

function activeRun(run: Record<string, unknown>): boolean {
  return run.conclusion === null && activeRunStatuses.some(status => run.status === status);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PolicyError("invalid-object");
  return value as Record<string, unknown>;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new PolicyError("invalid-identity");
  return value;
}

async function trustedRun(api: GitHubApi, run: Record<string, unknown>, phase: Phase): Promise<void> {
  if (record(run.repository).full_name !== repository || record(run.head_repository).full_name !== repository) throw new PolicyError("untrusted-run-repository");
  if (typeof run.head_sha !== "string" || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new PolicyError("invalid-run-head");
  if (run.event === "push" && run.head_branch === "main") {
    const ref = record(await readApi(api, `${endpoint}/git/ref/heads/main`, `${phase}-main-ref-api`));
    if (record(ref.object).sha !== run.head_sha) throw new PolicyError("stale-main");
    return;
  }
  if (run.event !== "pull_request" || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) throw new PolicyError("ineligible-event");
  const number = positive(record(run.pull_requests[0]).number);
  const pr = record(await readApi(api, `${endpoint}/pulls/${number}`, `${phase}-pr-api`));
  const head = record(pr.head);
  if (pr.state !== "open" || record(head.repo).full_name !== repository || record(record(pr.base).repo).full_name !== repository || head.sha !== run.head_sha) throw new PolicyError("untrusted-or-stale-pr");
}

async function facts(api: GitHubApi, jobId: number, phase: Phase = "queued") {
  positive(jobId);
  const job = record(await readApi(api, `${endpoint}/actions/jobs/${jobId}`, `${phase}-job-api`));
  const runId = positive(job.run_id);
  const run = record(await readApi(api, `${endpoint}/actions/runs/${runId}`, `${phase}-run-api`));
  if (job.id !== jobId || run.id !== runId || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha || !activeRun(run)) throw new PolicyError("stale-job-run");
  if (!targetsPcPool(job.labels)) throw new PolicyError("wrong-pool");
  await trustedRun(api, run, phase);
  return { job, admission: { jobId, runId, attempt: positive(run.run_attempt), headSha: String(run.head_sha) } };
}

export async function eligibleQueuedJob(api: GitHubApi, jobId: number): Promise<Admission> {
  const { job, admission } = await facts(api, jobId);
  if (job.status !== "queued" || (job.runner_id !== 0 && job.runner_id !== null)) throw new PolicyError("not-queued");
  return admission;
}

async function assignedJobId(api: GitHubApi, session: Session, hint: AssignmentHint, phase: Phase): Promise<number> {
  const result = record(await readApi(api, `${endpoint}/actions/runs/${hint.runId}/attempts/${hint.attempt}/jobs?per_page=100`, `${phase}-inventory-api`));
  if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count !== result.jobs.length || result.jobs.length > 100) throw new PolicyError("incomplete-inventory");
  const jobs = result.jobs.map(record);
  const ids = new Set<number>();
  for (const job of jobs) {
    const id = positive(job.id);
    if (ids.has(id) || job.run_id !== hint.runId || job.run_attempt !== hint.attempt || typeof job.status !== "string") throw new PolicyError("invalid-inventory");
    if (job.runner_id !== null && (typeof job.runner_id !== "number" || !Number.isSafeInteger(job.runner_id) || job.runner_id < 0)) throw new PolicyError("invalid-inventory-runner");
    ids.add(id);
  }
  const matches = jobs.filter(job => job.runner_id === session.runnerId);
  const job = matches[0];
  if (matches.length !== 1 || !job || job.status !== "in_progress") throw new PolicyError("assignment-not-unique-active");
  return positive(job.id);
}

async function assignedFacts(api: GitHubApi, session: Session, hint: AssignmentHint, jobId: number, phase: Phase): Promise<Assignment> {
  const { job, admission } = await facts(api, jobId, phase);
  if (admission.runId !== hint.runId || admission.attempt !== hint.attempt || job.runner_id !== session.runnerId || job.status !== "in_progress" || job.conclusion !== null) throw new PolicyError("unbound-assignment");
  return { ...admission, runnerId: session.runnerId };
}

export async function approveAssignedJob(api: GitHubApi, session: Session, hint: AssignmentHint): Promise<Assignment> {
  positive(session.runnerId);
  positive(hint.runId);
  positive(hint.attempt);
  const jobId = await atStage("initial-inventory", () => assignedJobId(api, session, hint, "initial"));
  const assignment = await atStage("initial-facts", () => assignedFacts(api, session, hint, jobId, "initial"));
  if (await atStage("fresh-inventory", () => assignedJobId(api, session, hint, "fresh")) !== jobId) throw new PolicyError("changed-assignment", "fresh-assignment");
  const latest = await atStage("fresh-facts", () => assignedFacts(api, session, hint, jobId, "fresh"));
  if (latest.headSha !== assignment.headSha) throw new PolicyError("changed-head", "fresh-head");
  return latest;
}
