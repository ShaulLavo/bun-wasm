import { claimWindowMs, compareRuns, dispatchFailure, macUnreachable, pausedMessage, redMessage, resumedMessage, type Completed, type Dispatch, type Job, type Outcome, type Run, type State } from "./model";

export type Adapters = {
  discover(): Promise<Run[]>;
  save(state: State): Promise<void>;
  dispatch(job: Job, attempt: number): Promise<void>;
  notify(message: string): Promise<void>;
  /** Bounded Mac probe; ticks call it only while an outage is recorded. */
  reachable(): Promise<boolean>;
  now(): string;
};

export function complete(job: Job, result: Outcome, now: string): void {
  if (job.state.kind !== "running") throw new Error("Job is not running");
  if (!job.state.claimedAt) throw new Error("Claim the job before completing it");
  if (result.revision !== job.revision) throw new Error("Wrong result source");
  // A Mac outage never sends the per-commit regression alert; the outage notice covers it.
  const silent = result.status === "green" || (result.status === "red" && result.operational === macUnreachable);
  const finished: Completed = { kind: "complete", attempt: job.state.attempt, lastGreen: job.state.lastGreen, finishedAt: now, outcome: result, notified: silent };
  if (!retriesAutomatically(job, result)) { job.state = finished; return; }
  // The completing harness proved cleanup before `complete`; the archived result is the retry's cleanup basis.
  job.history.push({ ...finished, notified: true });
  job.state = { kind: "pending", attempt: finished.attempt + 1 };
}

// The gate itself flakes, so the first ordinary red of a revision is retried once before anyone is told.
function retriesAutomatically(job: Job, result: Outcome): boolean {
  if (result.status !== "red" || result.operational) return false;
  return !job.history.some(entry => entry.outcome.status === "red");
}

/** Complete a job and apply Mac availability: an unreachable Mac pauses the queue, any other result ends an outage. */
export function record(state: State, job: Job, result: Outcome, now: string): void {
  complete(job, result, now);
  if (result.status === "red" && result.operational === macUnreachable) { pause(state, job, result, now); return; }
  resume(state, now);
}

function pause(state: State, job: Job, result: Outcome, now: string): void {
  if (state.mac.kind !== "unreachable") state.mac = { kind: "unreachable", since: now, revision: job.revision, reportPath: result.reportPath, notified: false };
  for (const queued of state.jobs) if (queued.state.kind === "pending") queued.state = { kind: "paused", attempt: queued.state.attempt };
}

// Only the newest successful main is smoked after an outage; older paused mains stay paused.
function resume(state: State, now: string): void {
  if (state.mac.kind !== "unreachable") return;
  const newest = state.jobs.toSorted(compareRuns).at(-1);
  if (!newest) { state.mac = { kind: "reachable" }; return; }
  state.mac = { kind: "resumed", since: state.mac.since, at: now, revision: newest.revision, notified: false };
  if (newest.state.kind === "paused") { newest.state = { kind: "pending", attempt: newest.state.attempt }; return; }
  if (newest.state.kind !== "complete" || newest.state.outcome.status !== "red" || newest.state.outcome.operational !== macUnreachable) return;
  newest.history.push(newest.state);
  newest.state = { kind: "pending", attempt: newest.state.attempt + 1 };
}

/** Send each Mac availability notice once; a failed send stays durable for the next tick. */
export async function macNotice(state: State, notify: (message: string) => Promise<void>, save: (state: State) => Promise<void>): Promise<void> {
  if (state.mac.kind === "reachable" || state.mac.notified) return;
  await notify(state.mac.kind === "unreachable" ? pausedMessage(state.mac) : resumedMessage(state.mac));
  state.mac = state.mac.kind === "unreachable" ? { ...state.mac, notified: true } : { kind: "reachable" };
  await save(state);
}

export function claim(job: Job, attempt: number, now: string): void {
  if (job.state.kind !== "running" || job.state.attempt !== attempt) throw new Error("Job attempt is no longer running");
  if (job.state.claimedAt) throw new Error("Job attempt is already claimed; audit and clean up before retrying");
  job.state.claimedAt = now;
}

export function retry(job: Job): void {
  if (job.state.kind === "pending") throw new Error("Job is already pending");
  if (job.state.kind === "paused") { job.state = { kind: "pending", attempt: job.state.attempt }; return; }
  if (job.state.kind === "complete" && !job.state.notified) throw new Error("Deliver the red notification before retrying");
  const attempt = job.state.attempt + 1;
  if (job.state.kind === "complete") job.history.push(job.state);
  job.state = { kind: "pending", attempt };
}

async function notifications(state: State, adapters: Adapters): Promise<void> {
  await macNotice(state, adapters.notify, adapters.save);
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
  if (!(await available(state, adapters))) return;
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

// During an outage newly enrolled mains are paused and nothing is dispatched until the probe answers.
async function available(state: State, adapters: Adapters): Promise<boolean> {
  if (state.mac.kind !== "unreachable") return true;
  for (const job of state.jobs) if (job.state.kind === "pending") job.state = { kind: "paused", attempt: job.state.attempt };
  let back = false;
  try { back = await adapters.reachable(); }
  catch (error) { state.error = String(error); }
  if (back) resume(state, adapters.now());
  await adapters.save(state);
  if (!back) return false;
  await macNotice(state, adapters.notify, adapters.save);
  return true;
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
  return ["# iPhone smoke automation", "", `Activation: ${state.since}. Last poll: ${state.polledAt ?? "never"}.`, `Watcher error: ${state.error ?? "none"}.`, `Mac: ${macLabel(state)}.`, "", "| Source revision | CI run | Attempt | Result |", "| --- | --- | --- | --- |"].concat(rows, [""]).join("\n");
}

function macLabel(state: State): string {
  if (state.mac.kind === "reachable") return "reachable";
  if (state.mac.kind === "resumed") return `back since ${state.mac.at}; resume notice ${state.mac.notified ? "sent" : "pending"}`;
  return `unreachable since ${state.mac.since}; smokes paused; pause notice ${state.mac.notified ? "sent" : "pending"}`;
}

function label(job: Job): string {
  if (job.state.kind === "running") return `running; dispatch ${job.state.claimedAt ? "claimed" : dispatchLabel(job.state.dispatch)}; claimed ${job.state.claimedAt ?? "no"}`;
  if (job.state.kind === "paused") return "paused; Mac unreachable; not dispatched";
  const earlier = job.history.at(-1);
  if (job.state.kind === "pending" && earlier?.outcome.status === "red") return `pending retry; attempt ${earlier.attempt} red at ${earlier.outcome.failedPhase}; report ${earlier.outcome.reportPath}`;
  if (job.state.kind !== "complete") return job.state.kind;
  const result: Completed = job.state;
  const classification = result.outcome.status !== "red" || !result.outcome.operational ? result.outcome.status
    : result.outcome.operational === macUnreachable ? "PAUSED; Mac unreachable; no smoke ran" : "OPERATIONAL ALERT; raw result red; cleanup unproved";
  return `${classification}${result.outcome.failedPhase ? ` at ${result.outcome.failedPhase}` : ""}; report ${result.outcome.reportPath}; notification ${result.notified ? "sent or unnecessary" : "pending"}`;
}

function dispatchLabel(delivery: Dispatch): string {
  if (delivery.kind === "unclaimed") return `unclaimed; dispatch alert ${delivery.notified ? "sent" : "pending"}`;
  if (delivery.kind !== "waiting") return delivery.kind;
  return `delivery ${delivery.delivery}; claim deadline ${delivery.claimDeadline}`;
}
