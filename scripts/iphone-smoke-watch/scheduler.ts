import { claimWindowMs, compareRuns, dispatchFailure, redMessage, type Completed, type Dispatch, type Job, type Outcome, type Run, type State } from "./model";

export type Adapters = {
  discover(): Promise<Run[]>;
  save(state: State): Promise<void>;
  dispatch(job: Job, attempt: number): Promise<void>;
  notify(message: string): Promise<void>;
  now(): string;
};

export function complete(job: Job, result: Outcome, now: string): void {
  if (job.state.kind !== "running") throw new Error("Job is not running");
  if (!job.state.claimedAt) throw new Error("Claim the job before completing it");
  if (result.revision !== job.revision) throw new Error("Wrong result source");
  job.state = { kind: "complete", attempt: job.state.attempt, lastGreen: job.state.lastGreen, finishedAt: now, outcome: result, notified: result.status === "green" };
}

export function claim(job: Job, attempt: number, now: string): void {
  if (job.state.kind !== "running" || job.state.attempt !== attempt) throw new Error("Job attempt is no longer running");
  if (job.state.claimedAt) throw new Error("Job attempt is already claimed; audit and clean up before retrying");
  job.state.claimedAt = now;
}

export function retry(job: Job): void {
  if (job.state.kind === "pending") throw new Error("Job is already pending");
  if (job.state.kind === "complete" && !job.state.notified) throw new Error("Deliver the red notification before retrying");
  const attempt = job.state.attempt + 1;
  if (job.state.kind === "complete") job.history.push(job.state);
  job.state = { kind: "pending", attempt };
}

async function notifications(state: State, adapters: Adapters): Promise<void> {
  for (const job of state.jobs) {
    await dispatchNotification(state, job, adapters);
    if (job.state.kind !== "complete" || job.state.notified) continue;
    await adapters.notify(redMessage(job, job.state));
    job.state.notified = true;
    await adapters.save(state);
  }
}

async function dispatchNotification(state: State, job: Job, adapters: Adapters): Promise<void> {
  if (job.state.kind !== "running" || job.state.claimedAt || job.state.dispatch.kind !== "unclaimed" || job.state.dispatch.notified) return;
  await adapters.notify(dispatchFailure(job, job.state.attempt));
  job.state.dispatch.notified = true;
  await adapters.save(state);
}

function precedingGreen(state: State, next: Job): string | null {
  const predecessors = state.jobs.filter(job => compareRuns(job, next) < 0 && job.state.kind === "complete" && job.state.outcome.status === "green");
  predecessors.sort(compareRuns);
  return predecessors.at(-1)?.revision ?? null;
}

export async function tick(state: State, adapters: Adapters): Promise<void> {
  await notifications(state, adapters);
  try {
    const runs = await adapters.discover();
    const known = new Set(state.jobs.map(job => job.revision));
    for (const run of runs.sort(compareRuns)) enroll(state, run, known);
    state.polledAt = adapters.now();
    state.error = null;
  } catch (error) {
    state.error = String(error);
  }
  await adapters.save(state);
  const active = state.jobs.find(job => job.state.kind === "running");
  if (active?.state.kind === "running") {
    await dispatch(state, active, adapters);
    return;
  }
  const next = state.jobs.filter(job => job.state.kind === "pending").sort(compareRuns)[0];
  if (!next) return;
  const attempt = next.state.attempt;
  next.state = { kind: "running", attempt, lastGreen: precedingGreen(state, next), startedAt: adapters.now(), dispatch: { kind: "pending" }, claimedAt: null };
  await adapters.save(state);
  await dispatch(state, next, adapters);
}

async function dispatch(state: State, job: Job, adapters: Adapters): Promise<void> {
  if (job.state.kind !== "running" || job.state.claimedAt) return;
  const previous = job.state.dispatch;
  if (previous.kind === "unclaimed") return;
  if (previous.kind === "waiting" && Date.parse(adapters.now()) < Date.parse(previous.claimDeadline)) return;
  if (previous.kind === "waiting" && previous.delivery === 2) {
    job.state.dispatch = { kind: "unclaimed", notified: false };
    await adapters.save(state);
    await dispatchNotification(state, job, adapters);
    return;
  }
  job.state.dispatch = { kind: "waiting", delivery: previous.kind === "pending" ? 1 : 2, claimDeadline: new Date(Date.parse(adapters.now()) + claimWindowMs).toISOString() };
  await adapters.save(state);
  try { await adapters.dispatch(job, job.state.attempt); }
  catch (error) { state.error = String(error); }
  job.state.dispatch.claimDeadline = new Date(Date.parse(adapters.now()) + claimWindowMs).toISOString();
  await adapters.save(state);
}

function enroll(state: State, run: Run, known: Set<string>): void {
  if (known.has(run.revision)) return;
  state.jobs.push({ ...run, history: [], state: { kind: "pending", attempt: 1 } });
  known.add(run.revision);
}

export function status(state: State): string {
  const rows = state.jobs.toSorted(compareRuns).map(job => `| ${job.revision} | ${job.id} | ${job.state.attempt} | ${label(job)} |`);
  return ["# iPhone smoke automation", "", `Activation: ${state.since}. Last poll: ${state.polledAt ?? "never"}.`, `Watcher error: ${state.error ?? "none"}.`, "", "| Source revision | CI run | Attempt | Result |", "| --- | --- | --- | --- |"].concat(rows, [""]).join("\n");
}

function label(job: Job): string {
  if (job.state.kind === "running") return `running; dispatch ${job.state.claimedAt ? "claimed" : dispatchLabel(job.state.dispatch)}; claimed ${job.state.claimedAt ?? "no"}`;
  if (job.state.kind !== "complete") return job.state.kind;
  const result: Completed = job.state;
  return `${result.outcome.status}${result.outcome.failedPhase ? ` at ${result.outcome.failedPhase}` : ""}; report ${result.outcome.reportPath}; notification ${result.notified ? "sent or unnecessary" : "pending"}`;
}

function dispatchLabel(delivery: Dispatch): string {
  if (delivery.kind === "unclaimed") return `unclaimed; dispatch alert ${delivery.notified ? "sent" : "pending"}`;
  if (delivery.kind !== "waiting") return delivery.kind;
  return `delivery ${delivery.delivery}; claim deadline ${delivery.claimDeadline}`;
}
