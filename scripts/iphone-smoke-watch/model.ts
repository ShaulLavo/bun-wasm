import { isAbsolute } from "node:path";
import { tabCountAlert } from "./tab-count-alert";

export type Run = { revision: string; id: number; number: number; createdAt: string };
export type Outcome = { revision: string; reportPath: string } & (
  | { status: "green"; failedPhase: null }
  | { status: "red"; failedPhase: string; operational?: "safari-tab-count" | "mac-unreachable" }
);
/** A smoke worker reports this phase when the Mac never answered; it is an outage, not a regression. */
export const macUnreachable = "mac-unreachable";
export type Completed = { kind: "complete"; attempt: number; lastGreen: string | null; finishedAt: string; outcome: Outcome; notified: boolean };
export const claimWindowMs = 10 * 60_000;
export type Dispatch = { kind: "pending" } | { kind: "waiting"; delivery: 1 | 2; claimDeadline: string } | { kind: "unclaimed"; notified: boolean };
export type Job = Run & { history: Completed[]; state:
  | { kind: "pending"; attempt: number }
  // Not dispatched because the Mac was unreachable; only the newest main runs once it is back.
  | { kind: "paused"; attempt: number }
  | { kind: "running"; attempt: number; lastGreen: string | null; startedAt: string; dispatch: Dispatch; claimedAt: string | null }
  | Completed
};
/** Mac availability, with a durable flag for its one operational notice per transition. */
export type Mac =
  | { kind: "reachable" }
  | { kind: "unreachable"; since: string; revision: string; reportPath: string; notified: boolean }
  | { kind: "resumed"; since: string; at: string; revision: string; notified: boolean };
export type State = { schema: 1; since: string; polledAt: string | null; error: string | null; mac: Mac; jobs: Job[] };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected nonempty text");
  return value;
}

export function revision(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error("Expected a full source revision");
  return result;
}

export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive integer");
  return value;
}

export function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error("Expected a UTC timestamp");
  return new Date(result).toISOString();
}

export function outcome(value: unknown, expected: string): Outcome {
  const data = object(value);
  if (revision(data.revision) !== expected) throw new Error("Smoke result source differs from scheduled revision");
  const reportPath = text(data.reportPath);
  if (!isAbsolute(reportPath)) throw new Error("Smoke reportPath must be absolute");
  const base = { revision: expected, reportPath };
  if (data.status === "green" && data.failedPhase === null) return { ...base, status: "green", failedPhase: null };
  if (data.status === "red") {
    const result: Outcome = { ...base, status: "red", failedPhase: text(data.failedPhase) };
    if (result.failedPhase === macUnreachable) return { ...result, operational: macUnreachable };
    return tabCountAlert(data) ? { ...result, operational: "safari-tab-count" } : result;
  }
  throw new Error("Invalid smoke result status or failed phase");
}

function nullableRevision(value: unknown): string | null { return value === null ? null : revision(value); }

function completed(value: unknown, expected: string): Completed {
  const data = object(value);
  if (data.kind !== "complete" || typeof data.notified !== "boolean") throw new Error("Invalid completed job");
  return { kind: "complete", attempt: integer(data.attempt), lastGreen: nullableRevision(data.lastGreen), finishedAt: timestamp(data.finishedAt), outcome: storedOutcome(data.outcome, expected), notified: data.notified };
}

function storedOutcome(value: unknown, expected: string): Outcome {
  const data = object(value), result = outcome(data, expected);
  if (data.operational === undefined || (result.status === "red" && result.operational === data.operational)) return result;
  if (data.operational !== "safari-tab-count" || result.status !== "red" || result.failedPhase !== "cleanup") throw new Error("Invalid operational smoke classification");
  return { ...result, operational: data.operational };
}

function job(value: unknown): Job {
  const data = object(value), progress = object(data.state);
  const source = revision(data.revision);
  if (!Array.isArray(data.history)) throw new Error("Invalid job history");
  const base = { revision: source, id: integer(data.id), number: integer(data.number), createdAt: timestamp(data.createdAt), history: data.history.map(item => completed(item, source)) };
  const attempt = integer(progress.attempt);
  if (progress.kind === "pending" || progress.kind === "paused") return { ...base, state: { kind: progress.kind, attempt } };
  if (progress.kind === "running") return { ...base, state: running(progress, attempt) };
  return { ...base, state: completed(progress, source) };
}

function running(data: Record<string, unknown>, attempt: number): Extract<Job["state"], { kind: "running" }> {
  const startedAt = timestamp(data.startedAt);
  return { kind: "running", attempt, lastGreen: nullableRevision(data.lastGreen), startedAt, dispatch: dispatch(data.dispatch, startedAt), claimedAt: data.claimedAt === null ? null : timestamp(data.claimedAt) };
}

function dispatch(value: unknown, startedAt: string): Dispatch {
  // Upgrade durable snapshots written before claim deadlines existed.
  if (value === "pending" || value === "sent") return { kind: "waiting", delivery: 1, claimDeadline: new Date(Date.parse(startedAt) + claimWindowMs).toISOString() };
  const data = object(value);
  if (data.kind === "pending") return { kind: "pending" };
  if (data.kind === "unclaimed" && typeof data.notified === "boolean") return { kind: "unclaimed", notified: data.notified };
  if (data.kind === "waiting" && (data.delivery === 1 || data.delivery === 2)) return { kind: "waiting", delivery: data.delivery, claimDeadline: timestamp(data.claimDeadline) };
  throw new Error("Invalid dispatch state");
}

export function dispatchFailure(job: Job, attempt: number): string {
  return `iPhone smoke dispatch failure. No durable claim after two delivery windows of ten minutes. Source: ${job.revision}. Attempt: ${attempt}. CI run: https://github.com/ShaulLavo/bun-wasm/actions/runs/${job.id}. Smoke result remains outstanding; inspect watcher STATUS.md and the attempt dispatch.txt before an audited retry.`;
}

export function state(value: unknown): State {
  const data = object(value);
  if (data.schema !== 1 || !Array.isArray(data.jobs)) throw new Error("Invalid watcher state");
  const jobs = data.jobs.map(job);
  if (new Set(jobs.map(item => item.revision)).size !== jobs.length) throw new Error("Duplicate source in watcher state");
  if (jobs.filter(item => item.state.kind === "running").length > 1) throw new Error("Multiple running smoke jobs");
  return { schema: 1, since: timestamp(data.since), polledAt: data.polledAt === null ? null : timestamp(data.polledAt), error: data.error === null ? null : text(data.error), mac: data.mac === undefined ? inferredMac(jobs) : mac(data.mac), jobs };
}

const isMacUnreachable = (result: Completed) => result.outcome.status === "red" && result.outcome.operational === macUnreachable;

// Snapshots written before Mac outages were tracked: an outage is a trailing run of mac-unreachable
// results by finish time. Its pause notice was never sent.
function inferredMac(jobs: readonly Job[]): Mac {
  const results = jobs.flatMap(job => job.history.concat(job.state.kind === "complete" ? [job.state] : []).map(result => ({ job, result })));
  results.sort((first, second) => first.result.finishedAt.localeCompare(second.result.finishedAt));
  const start = results[results.findLastIndex(entry => !isMacUnreachable(entry.result)) + 1];
  if (!start) return { kind: "reachable" };
  return { kind: "unreachable", since: start.result.finishedAt, revision: start.job.revision, reportPath: start.result.outcome.reportPath, notified: false };
}

function mac(value: unknown): Mac {
  const data = object(value);
  if (data.kind === "reachable") return { kind: "reachable" };
  if (typeof data.notified !== "boolean") throw new Error("Invalid Mac availability");
  if (data.kind === "unreachable") return { kind: "unreachable", since: timestamp(data.since), revision: revision(data.revision), reportPath: text(data.reportPath), notified: data.notified };
  if (data.kind === "resumed") return { kind: "resumed", since: timestamp(data.since), at: timestamp(data.at), revision: revision(data.revision), notified: data.notified };
  throw new Error("Invalid Mac availability");
}

export function pausedMessage(outage: Extract<Mac, { kind: "unreachable" }>): string {
  return `iPhone smoke: Mac unreachable, iPhone smokes paused. This is an outage, not a regression: no smoke ran and the tested-green baseline is unchanged. First seen: ${outage.since} while testing ${outage.revision} (report ${outage.reportPath}). Newer mains are not dispatched while it lasts; once the Mac answers again, only the newest successful main is smoked.`;
}

export function resumedMessage(outage: Extract<Mac, { kind: "resumed" }>): string {
  return `iPhone smoke: Mac back, smokes resumed. The Mac answered at ${outage.at} after an outage since ${outage.since}. The next smoke is the newest successful main, ${outage.revision}; mains skipped during the outage stay paused.`;
}

export function compareRuns(first: Run, second: Run): number { return first.number - second.number || first.id - second.id; }

export function redMessage(job: Job, result: Completed): string {
  const previous = result.lastGreen ?? "none recorded";
  const range = result.lastGreen ? `${result.lastGreen}...${job.revision}` : `unavailable...${job.revision}`;
  if (result.outcome.status === "red" && result.outcome.operational === "safari-tab-count") return `iPhone smoke OPERATIONAL ALERT. Executed functional phases passed; Safari tab-count cleanup is unproved. The raw result remains red and the tested-green baseline is unchanged. Last tested green: ${previous}. Tested main: ${job.revision}. Compare range: ${range}. Failed phase: ${result.outcome.failedPhase}. Report: ${result.outcome.reportPath}. CI run: https://github.com/ShaulLavo/bun-wasm/actions/runs/${job.id}. Attempt: ${result.attempt}.`;
  const earlier = job.history.findLast(entry => entry.outcome.status === "red");
  const twice = earlier ? ` Failed twice: attempt ${earlier.attempt} failed at ${earlier.outcome.failedPhase} (report ${earlier.outcome.reportPath}), then attempt ${result.attempt}.` : "";
  return `iPhone smoke RED.${twice} Last tested green: ${previous}. Failing green main: ${job.revision}. Compare range: ${range}. Failed phase: ${result.outcome.failedPhase}. Report: ${result.outcome.reportPath}. CI run: https://github.com/ShaulLavo/bun-wasm/actions/runs/${job.id}. Attempt: ${result.attempt}.`;
}
