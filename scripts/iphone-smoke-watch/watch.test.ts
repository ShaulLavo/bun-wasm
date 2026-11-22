import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import "../iphone-smoke-watch";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { instructions } from "./dispatch";
import { discover } from "./github";
import { macReachable } from "./mac";
import { claimWindowMs, outcome, state as parseState, type Job, type Run, type State } from "./model";
import { claim, complete, record, retry, status, tick, type Adapters } from "./scheduler";
import { load, save } from "./storage";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const since = "2026-11-15T00:00:00.000Z";
const now = "2026-11-15T12:00:00.000Z";
const sha = (number: number) => number.toString(16).padStart(40, "0");
const run = (number: number): Run => ({ revision: sha(number), id: number + 100, number, createdAt: since });
const fresh = (): State => ({ schema: 1, since, polledAt: null, error: null, mac: { kind: "reachable" }, jobs: [] });
const green = (job: Job) => outcome({ revision: job.revision, status: "green", failedPhase: null, reportPath: "/reports/result.json" }, job.revision);
const red = (job: Job) => outcome({ revision: job.revision, status: "red", failedPhase: "prepare-artifacts", reportPath: "/reports/failure.md" }, job.revision);

function tabCountReport(revision = sha(1)) {
  const error = "AggregateError: Error: Cannot identify Safari tab count";
  const phases = ["startup", "install", "dev", "render", "click", "cleanup"].map(phase => ({ phase, status: phase === "cleanup" ? "fail" : "pass", error: phase === "cleanup" ? error : undefined }));
  const failures: { phase: string; error: string }[] = [];
  return { kind: "manual-iphone-smoke", revision, status: "red", failedPhase: "cleanup", reportPath: "/reports/cleanup.json", failures,
    cases: ["vite-react/iphone-safari/browser", "hono/iphone-safari/browser", "vite-react/iphone-safari/quickjs"].map((id, index) => ({ id,
      status: index === 0 ? "fail" : "blocked", phases: index === 0 ? phases : [],
      failures: [{ phase: index === 0 ? "cleanup" : "prerequisite", error: index === 0 ? error : "Previous case cleanup failed: " + error }],
    })) };
}

test("only exact tab-count cleanup failure after passing functional phases is operational", () => {
  expect(outcome(tabCountReport(), sha(1))).toMatchObject({ status: "red", failedPhase: "cleanup", operational: "safari-tab-count" });
  for (const phase of ["startup", "install", "dev", "render", "click"]) {
    const report = tabCountReport();
    report.cases[0]!.phases.find(row => row.phase === phase)!.status = "fail";
    expect(outcome(report, sha(1))).not.toHaveProperty("operational");
  }
});

test.each([1, 2])("operational cleanup can follow %s complete passing cases", passed => {
  const report = tabCountReport();
  const failed = structuredClone(report.cases[0]!);
  for (const [index, result] of report.cases.entries()) {
    if (index < passed) {
      result.status = "pass";
      result.phases = failed.phases.map(phase => ({ ...phase, status: "pass", error: undefined }));
      result.failures = [];
    }
    if (index === passed) Object.assign(result, failed, { id: result.id });
  }
  expect(outcome(report, sha(1))).toMatchObject({ status: "red", operational: "safari-tab-count" });
});

test("additional aggregate cleanup errors and interrupted functional phases remain red", () => {
  const report = tabCountReport();
  const cleanup = report.cases[0]!.phases[5]!;
  const error = "AggregateError: Error: Cannot identify Safari tab count; Error: owned tab identity failed";
  cleanup.error = error;
  report.cases[0]!.failures[0]!.error = error;
  expect(outcome(report, sha(1))).not.toHaveProperty("operational");
  const interrupted = tabCountReport();
  interrupted.cases[0]!.phases[4]!.status = "cancelled";
  expect(outcome(interrupted, sha(1))).not.toHaveProperty("operational");
});

test.each(["ownership", "closure", "mixed", "cancellation", "blocked-product", "missing-phase", "no-cases", "forged-label"])("%s failure never becomes an operational tab-count alert", scenario => {
  const report = tabCountReport();
  if (scenario === "ownership") report.cases[0]!.phases[5]!.error = "Error: Cannot identify the task's Safari tab for cleanup";
  if (scenario === "closure") report.cases[0]!.phases[5]!.error = "Error: Task Safari tab closure is unproved";
  if (scenario === "mixed") report.cases[0]!.failures.push({ phase: "render", error: "guest failed" });
  if (scenario === "cancellation") report.failures.push({ phase: "interruption", error: "cancelled during cleanup" });
  if (scenario === "blocked-product") report.cases[1]!.failures[0]!.error = "install failed";
  if (scenario === "missing-phase") report.cases[0]!.phases.splice(3, 1);
  if (scenario === "no-cases" || scenario === "forged-label") report.cases = [];
  expect(outcome({ ...report, operational: "safari-tab-count" }, sha(1))).not.toHaveProperty("operational");
});

test("operational notification survives restart and failure without advancing tested green", async () => {
  const state = fresh(), fake = harness([run(1), run(2), run(3)]);
  await tick(state, fake.adapters);
  finish(state, 1);
  await tick(state, fake.adapters);
  const job = state.jobs[1]!;
  claim(job, 1, now);
  complete(job, outcome(tabCountReport(sha(2)), sha(2)), now);
  const restored = parseState(JSON.parse(JSON.stringify(state)));
  fake.adapters.notify = async () => { throw new Error("notification unavailable"); };
  await expect(tick(restored, fake.adapters)).rejects.toThrow("notification unavailable");
  expect(restored.jobs[1]?.state).toMatchObject({ notified: false, outcome: { status: "red" } });
  fake.adapters.notify = async message => { fake.messages.push(message); };
  await tick(restored, fake.adapters);
  expect(fake.messages[0]).toContain("OPERATIONAL ALERT");
  expect(fake.messages[0]).not.toContain("smoke RED");
  for (const text of [sha(2), "cleanup", "/reports/cleanup.json", "unproved", "raw result remains red"]) expect(fake.messages[0]).toContain(text);
  expect(status(restored)).toContain("OPERATIONAL ALERT");
  expect(restored.jobs[2]?.state).toMatchObject({ kind: "running", lastGreen: sha(1) });
  await tick(restored, fake.adapters);
  expect(fake.messages).toHaveLength(1);
});

function harness(runs: Run[]) {
  const snapshots: State[] = [], dispatches: string[] = [], messages: string[] = [];
  const mac = { up: true, probes: 0 };
  let clock = Date.parse(now);
  const adapters: Adapters = {
    discover: async () => runs,
    save: async value => { snapshots.push(structuredClone(value)); },
    dispatch: async job => { dispatches.push(job.revision); },
    notify: async message => { messages.push(message); },
    reachable: async () => { mac.probes++; return mac.up; },
    now: () => new Date(clock).toISOString(),
  };
  return { adapters, snapshots, dispatches, messages, mac, advance: (ms: number) => { clock += ms; } };
}

function first(state: State): Job {
  const job = state.jobs[0];
  if (!job) throw new Error("Expected a queued job");
  return job;
}

function finish(state: State, source: number, passed = true): void {
  const job = state.jobs.find(job => job.revision === sha(source));
  if (!job) throw new Error("Expected scheduled source");
  claim(job, job.state.attempt, now);
  complete(job, passed ? green(job) : red(job), now);
}

test("every adjacent successful source is queued once, in source order", async () => {
  const state = fresh(), fake = harness([run(3), run(1), run(2), { ...run(1), id: 999 }]);
  await tick(state, fake.adapters);
  expect(state.jobs.map(job => job.revision)).toEqual([sha(1), sha(2), sha(3)]);
  expect(fake.snapshots.find(snapshot => first(snapshot).state.kind === "running")?.jobs[0]?.state).toMatchObject({ dispatch: { kind: "pending" } });
  finish(state, 1);
  await tick(state, fake.adapters);
  finish(state, 2);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1), sha(2), sha(3)]);
  expect(state.jobs[2]?.state).toMatchObject({ kind: "running", lastGreen: sha(2) });
});

test("a late success remains enrolled after a newer main was tested", async () => {
  const state = fresh(), fake = harness([run(2)]);
  await tick(state, fake.adapters);
  finish(state, 2);
  fake.adapters.discover = async () => [run(1), run(2), run(3)];
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(2), sha(1)]);
  const late = state.jobs.find(job => job.revision === sha(1));
  expect(late?.state).toMatchObject({ lastGreen: null });
  finish(state, 1);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(2), sha(1), sha(3)]);
  expect(state.jobs.find(job => job.revision === sha(3))?.state).toMatchObject({ lastGreen: sha(2) });
});

test("restart preserves running identity and duplicate messages cannot claim again", async () => {
  const state = fresh(), fake = harness([run(1), run(2)]);
  await tick(state, fake.adapters);
  const restored = parseState(JSON.parse(JSON.stringify(state)));
  claim(first(restored), 1, now);
  expect(() => claim(first(restored), 1, now)).toThrow("already claimed");
  await tick(restored, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1)]);
  expect(restored.jobs[1]?.state.kind).toBe("pending");
  retry(first(restored));
  expect(first(restored).state).toEqual({ kind: "pending", attempt: 2 });
  expect(() => claim(first(restored), 1, now)).toThrow("no longer running");
  await tick(restored, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
  expect(first(restored).state).toMatchObject({ attempt: 2, claimedAt: null });
});

test("acknowledged dispatch still needs a claim, then one retry and a separate operational alert", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  fake.advance(claimWindowMs - 1);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1)]);
  fake.advance(1);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
  expect(fake.messages).toEqual([]);
  fake.advance(claimWindowMs - 1);
  await tick(state, fake.adapters);
  expect(fake.messages).toEqual([]);
  fake.advance(1);
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("dispatch failure");
  expect(fake.messages[0]).not.toContain("smoke RED");
  expect(first(state).state).toMatchObject({ kind: "running", dispatch: { kind: "unclaimed" } });
  fake.advance(claimWindowMs * 3);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toHaveLength(2);
  expect(fake.messages).toHaveLength(1);
  finish(state, 1);
  await tick(state, fake.adapters);
  expect(first(state).state).toMatchObject({ kind: "complete", outcome: { status: "green" } });
  expect(fake.messages).toHaveLength(1);
});

test("a dispatch timeout waits for a durable claim without an immediate resend or red", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.dispatch = async job => { fake.dispatches.push(job.revision); throw new Error("ETIMEDOUT after delivery"); };
  await tick(state, fake.adapters);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1)]);
  expect(fake.messages).toEqual([]);
  claim(first(state), 1, now);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1)]);
  expect(() => claim(first(state), 1, now)).toThrow("already claimed");
});

test.each([false, true])("claim during grace, after retry = %s, stops dispatch recovery", async afterRetry => {
  const state = fresh(), fake = harness([run(1), run(2)]);
  fake.adapters.dispatch = async job => { fake.dispatches.push(job.revision); throw new Error("timeout"); };
  await tick(state, fake.adapters);
  if (afterRetry) { fake.advance(claimWindowMs); await tick(state, fake.adapters); }
  claim(first(state), 1, fake.adapters.now());
  fake.advance(claimWindowMs * 3);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toHaveLength(afterRetry ? 2 : 1);
  expect(fake.messages).toEqual([]);
  expect(state.jobs[1]?.state.kind).toBe("pending");
  expect(() => claim(first(state), 1, fake.adapters.now())).toThrow("already claimed");
  await failTwice(state, first(state), fake);
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("smoke RED");
  expect(fake.messages[0]).toContain("prepare-artifacts");
});

async function failTwice(state: State, job: Job, fake: ReturnType<typeof harness>): Promise<void> {
  complete(job, red(job), fake.adapters.now());
  await tick(state, fake.adapters);
  claim(job, 2, fake.adapters.now());
  complete(job, red(job), fake.adapters.now());
}

const redAt = (job: Job, reportPath: string) => outcome({ revision: job.revision, status: "red", failedPhase: "render", reportPath }, job.revision);

test("a red retried once that turns green notifies nobody", async () => {
  const state = fresh(), fake = harness([run(1), run(2)]);
  await tick(state, fake.adapters);
  const job = first(state);
  claim(job, 1, now);
  complete(job, redAt(job, "/reports/attempt-1.json"), now);
  expect(job.state).toEqual({ kind: "pending", attempt: 2 });
  expect(job.history).toMatchObject([{ attempt: 1, outcome: { status: "red", reportPath: "/reports/attempt-1.json" } }]);
  expect(status(state)).toContain("pending retry; attempt 1 red at render; report /reports/attempt-1.json");
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
  expect(job.state).toMatchObject({ kind: "running", attempt: 2 });
  claim(job, 2, now);
  complete(job, green(job), now);
  await tick(state, fake.adapters);
  await tick(state, fake.adapters);
  expect(fake.messages).toEqual([]);
  expect(job.state).toMatchObject({ kind: "complete", attempt: 2, outcome: { status: "green" } });
  expect(state.jobs[1]?.state).toMatchObject({ kind: "running", lastGreen: sha(1) });
});

test("a red retry sends one notification naming both failed attempts", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  const job = first(state);
  claim(job, 1, now);
  complete(job, redAt(job, "/reports/attempt-1.json"), now);
  const restored = parseState(JSON.parse(JSON.stringify(state)));
  await tick(restored, fake.adapters);
  expect(fake.messages).toEqual([]);
  claim(first(restored), 2, now);
  complete(first(restored), redAt(first(restored), "/reports/attempt-2.json"), now);
  expect(first(restored).state).toMatchObject({ kind: "complete", attempt: 2, notified: false });
  await tick(restored, fake.adapters);
  await tick(restored, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  for (const text of ["smoke RED", "Failed twice", "attempt 1", "/reports/attempt-1.json", "/reports/attempt-2.json", "Attempt: 2."]) expect(fake.messages[0]).toContain(text);
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
});

test("restart retains both deadlines, the single retry, and a failed operational notification", async () => {
  let state = fresh();
  const path = await directory(), fake = harness([run(1)]);
  fake.adapters.save = value => save(path, value);
  fake.adapters.dispatch = async job => { fake.dispatches.push(job.revision); throw new Error("timeout"); };
  await tick(state, fake.adapters);
  const firstDeadline = first(state).state;
  state = await load(path);
  expect(first(state).state).toEqual(firstDeadline);
  fake.advance(claimWindowMs - 1);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toHaveLength(1);
  fake.advance(1);
  await tick(state, fake.adapters);
  const secondDeadline = first(state).state;
  state = await load(path);
  expect(first(state).state).toEqual(secondDeadline);
  fake.advance(claimWindowMs - 1);
  await tick(state, fake.adapters);
  expect(fake.messages).toEqual([]);
  fake.advance(1);
  fake.adapters.notify = async () => { throw new Error("notification timeout"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("notification timeout");
  state = await load(path);
  expect(first(state).state).toMatchObject({ dispatch: { kind: "unclaimed", notified: false } });
  fake.adapters.notify = async message => { fake.messages.push(message); };
  await tick(state, fake.adapters);
  state = await load(path);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toHaveLength(2);
  expect(fake.messages).toHaveLength(1);
  expect(first(state).state).toMatchObject({ dispatch: { kind: "unclaimed", notified: true } });
}, 60_000);

test("each send return refreshes a full claim window even after a slow timeout", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.dispatch = async job => { fake.dispatches.push(job.revision); fake.advance(60_000); throw new Error("timeout"); };
  await tick(state, fake.adapters);
  expect(first(state).state).toMatchObject({ dispatch: { claimDeadline: new Date(Date.parse(fake.adapters.now()) + claimWindowMs).toISOString() } });
  fake.advance(claimWindowMs - 1);
  await tick(state, fake.adapters);
  expect(fake.dispatches).toHaveLength(1);
  fake.advance(1);
  await tick(state, fake.adapters);
  expect(first(state).state).toMatchObject({ dispatch: { delivery: 2, claimDeadline: new Date(Date.parse(fake.adapters.now()) + claimWindowMs).toISOString() } });
  fake.advance(claimWindowMs - 1);
  await tick(state, fake.adapters);
  expect(fake.messages).toEqual([]);
});

test("a late durable claim cancels an unsent no-claim alert and preserves real red reporting", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  fake.advance(claimWindowMs);
  await tick(state, fake.adapters);
  fake.advance(claimWindowMs);
  fake.adapters.notify = async () => { throw new Error("offline"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("offline");
  claim(first(state), 1, fake.adapters.now());
  await failTwice(state, first(state), fake);
  fake.adapters.notify = async message => { fake.messages.push(message); };
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("smoke RED");
});

test("pre-deadline durable snapshots retain claims and conservatively count their first delivery", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  const job = first(state);
  if (job.state.kind !== "running") throw new Error("Expected running state");
  for (const dispatch of ["pending", "sent"]) {
    const restored = parseState({ ...state, jobs: [{ ...job, state: { ...job.state, dispatch } }] });
    expect(first(restored).state).toMatchObject({ dispatch: { kind: "waiting", delivery: 1, claimDeadline: new Date(Date.parse(now) + claimWindowMs).toISOString() }, claimedAt: null });
  }
  claim(job, 1, now);
  const restored = parseState({ ...state, jobs: [{ ...job, state: { ...job.state, dispatch: "sent" } }] });
  fake.advance(claimWindowMs * 3);
  await tick(restored, fake.adapters);
  expect(fake.dispatches).toHaveLength(1);
  expect(() => claim(first(restored), 1, now)).toThrow("already claimed");
});

test("an interrupted save before dispatch cannot launch a job", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.save = async value => { if (first(value).state.kind === "running") throw new Error("disk interrupted"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("disk interrupted");
  expect(fake.dispatches).toEqual([]);
});

test("crash after send preserves its claim window and consumes at most one retry", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.save = async value => {
    if (fake.dispatches.length > 0) throw new Error("ack save interrupted");
    fake.snapshots.push(structuredClone(value));
  };
  await expect(tick(state, fake.adapters)).rejects.toThrow("ack save interrupted");
  const persisted = fake.snapshots.at(-1);
  if (!persisted) throw new Error("Expected durable dispatch intent");
  expect(first(persisted).state).toMatchObject({ dispatch: { kind: "waiting", delivery: 1 } });
  fake.adapters.save = async value => {
    if (fake.dispatches.length === 2) throw new Error("retry ack save interrupted");
    fake.snapshots.push(structuredClone(value));
  };
  await tick(persisted, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1)]);
  fake.advance(claimWindowMs);
  await expect(tick(persisted, fake.adapters)).rejects.toThrow("retry ack save interrupted");
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
  const retried = fake.snapshots.at(-1);
  if (!retried) throw new Error("Expected durable retry intent");
  expect(first(retried).state).toMatchObject({ dispatch: { delivery: 2 } });
  fake.adapters.save = async () => {};
  fake.advance(claimWindowMs);
  await tick(retried, fake.adapters);
  expect(fake.dispatches).toHaveLength(2);
  expect(fake.messages).toHaveLength(1);
  claim(first(retried), 1, now);
  expect(() => claim(first(retried), 1, now)).toThrow("already claimed");
});

test("setup failure is red and reports tested predecessor, range, phase and report", async () => {
  const state = fresh(), fake = harness([run(1), run(2)]);
  await tick(state, fake.adapters);
  finish(state, 1);
  await tick(state, fake.adapters);
  finish(state, 2, false);
  await tick(state, fake.adapters);
  expect(fake.messages).toEqual([]);
  finish(state, 2, false);
  fake.adapters.notify = async () => { throw new Error("notification unavailable"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("notification unavailable");
  expect(state.jobs[1]?.state).toMatchObject({ notified: false, outcome: { status: "red" } });
  fake.adapters.notify = async message => { fake.messages.push(message); };
  await tick(state, fake.adapters);
  expect(fake.messages[0]).toContain(`Last tested green: ${sha(1)}`);
  expect(fake.messages[0]).toContain(`Failing green main: ${sha(2)}`);
  expect(fake.messages[0]).toContain(`${sha(1)}...${sha(2)}`);
  expect(fake.messages[0]).toContain("prepare-artifacts");
  expect(fake.messages[0]).toContain("/reports/failure.md");
  expect(fake.messages[0]).toContain("Failed twice");
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
});

const unreachable = (job: Job) => outcome({ revision: job.revision, status: "red", failedPhase: "mac-unreachable", reportPath: "/reports/mac.md", cases: [] }, job.revision);

async function outage(runs: Run[]) {
  const state = fresh(), fake = harness(runs);
  fake.mac.up = false;
  await tick(state, fake.adapters);
  const job = first(state);
  claim(job, 1, now);
  record(state, job, unreachable(job), now);
  return { state, fake, job };
}

test("an unreachable Mac sends one pause notice, no per-commit RED and no automatic retry", async () => {
  const { state, fake, job } = await outage([run(1), run(2)]);
  expect(job.state).toMatchObject({ kind: "complete", attempt: 1, notified: true, outcome: { failedPhase: "mac-unreachable", operational: "mac-unreachable" } });
  expect(job.history).toEqual([]);
  expect(state.mac).toMatchObject({ kind: "unreachable", since: now, revision: sha(1), reportPath: "/reports/mac.md", notified: false });
  await tick(state, fake.adapters);
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("Mac unreachable, iPhone smokes paused");
  expect(fake.messages[0]).not.toContain("smoke RED");
  expect(fake.dispatches).toEqual([sha(1)]);
  expect(fake.mac.probes).toBe(2);
  expect(state.jobs[1]?.state).toEqual({ kind: "paused", attempt: 1 });
  expect(status(state)).toContain("PAUSED; Mac unreachable; no smoke ran");
  expect(status(state)).toContain("Mac: unreachable since");
});

test("mains that succeed during an outage are paused, never dispatched", async () => {
  const runs = [run(1)], { state, fake } = await outage(runs);
  for (const number of [2, 3]) {
    runs.push(run(number));
    await tick(state, fake.adapters);
  }
  expect(fake.dispatches).toEqual([sha(1)]);
  expect(state.jobs.map(job => job.state.kind)).toEqual(["complete", "paused", "paused"]);
  expect(status(state)).toContain("paused; Mac unreachable; not dispatched");
  expect(fake.messages.filter(message => message.includes("smoke RED"))).toEqual([]);
});

test("the probe finding the Mac back smokes only the newest main and sends one resume notice", async () => {
  const { state, fake } = await outage([run(1), run(2), run(3)]);
  await tick(state, fake.adapters);
  fake.mac.up = true;
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1), sha(3)]);
  expect(state.jobs.map(job => job.state.kind)).toEqual(["complete", "paused", "running"]);
  expect(fake.messages).toHaveLength(2);
  expect(fake.messages[1]).toContain("Mac back, smokes resumed");
  expect(fake.messages[1]).toContain(sha(3));
  expect(state.mac).toEqual({ kind: "reachable" });
  const probes = fake.mac.probes;
  await tick(state, fake.adapters);
  expect(fake.mac.probes).toBe(probes);
  expect(fake.messages).toHaveLength(2);
});

test("when the outage source is also the newest main, it is smoked again as a fresh attempt", async () => {
  const { state, fake, job } = await outage([run(1)]);
  fake.mac.up = true;
  await tick(state, fake.adapters);
  expect(job.state).toMatchObject({ kind: "running", attempt: 2 });
  expect(job.history).toMatchObject([{ attempt: 1, outcome: { failedPhase: "mac-unreachable" } }]);
  claim(job, 2, now);
  record(state, job, green(job), now);
  await tick(state, fake.adapters);
  expect(fake.messages.map(message => message.slice(0, 40))).toEqual(["iPhone smoke: Mac unreachable, iPhone sm", "iPhone smoke: Mac back, smokes resumed. "]);
});

test("a later result that is not mac-unreachable ends the outage without waiting for the probe", async () => {
  const { state, fake, job } = await outage([run(1), run(2)]);
  await tick(state, fake.adapters);
  retry(job);
  job.state = { kind: "running", attempt: 2, lastGreen: null, startedAt: now, dispatch: { kind: "waiting", delivery: 1, claimDeadline: now }, claimedAt: now };
  record(state, job, green(job), now);
  expect(state.mac).toMatchObject({ kind: "resumed", revision: sha(2), notified: false });
  expect(state.jobs[1]?.state).toEqual({ kind: "pending", attempt: 1 });
  const probes = fake.mac.probes;
  await tick(state, fake.adapters);
  expect(fake.mac.probes).toBe(probes);
  expect(fake.dispatches).toEqual([sha(1), sha(2)]);
  expect(fake.messages.at(-1)).toContain("Mac back, smokes resumed");
});

test("outage notices survive a failed send and a restart, and are sent once", async () => {
  const { state, fake } = await outage([run(1), run(2)]);
  fake.adapters.notify = async () => { throw new Error("notification timeout"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("notification timeout");
  const restored = parseState(JSON.parse(JSON.stringify(state)));
  expect(restored.mac).toMatchObject({ kind: "unreachable", notified: false });
  fake.adapters.notify = async message => { fake.messages.push(message); };
  await tick(restored, fake.adapters);
  await tick(restored, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  expect(parseState(JSON.parse(JSON.stringify(restored))).jobs[1]?.state).toEqual({ kind: "paused", attempt: 1 });
});

test("a failing probe keeps smokes paused and records the error", async () => {
  const { state, fake } = await outage([run(1), run(2)]);
  fake.adapters.reachable = async () => { throw new Error("tailscale missing"); };
  await tick(state, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1)]);
  expect(state.error).toContain("tailscale missing");
  expect(state.mac.kind).toBe("unreachable");
});

test("other red phases keep one automatic retry, then notify, and never probe the Mac", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  for (const attempt of [1, 2]) {
    claim(first(state), attempt, now);
    record(state, first(state), red(first(state)), now);
    await tick(state, fake.adapters);
  }
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("smoke RED");
  expect(state.mac).toEqual({ kind: "reachable" });
  expect(fake.mac.probes).toBe(0);
});

test("state written before outages were tracked infers an outage from its trailing mac-unreachable results", async () => {
  const legacy = JSON.parse(JSON.stringify(fresh()));
  delete legacy.mac;
  const result = (number: number, at: string, failedPhase: string | null) => ({ kind: "complete", attempt: 1, lastGreen: null, finishedAt: at, notified: true,
    outcome: { revision: sha(number), status: failedPhase ? "red" : "green", failedPhase, reportPath: `/reports/${number}.md` } });
  const green1 = { ...run(1), history: [], state: result(1, "2026-11-15T01:00:00.000Z", null) };
  const red2 = { ...run(2), history: [], state: result(2, "2026-11-15T02:00:00.000Z", "render") };
  const mac3 = { ...run(3), history: [result(3, "2026-11-15T03:00:00.000Z", "mac-unreachable")], state: { ...result(3, "2026-11-15T04:00:00.000Z", "mac-unreachable"), attempt: 2 } };
  const mac4 = { ...run(4), history: [result(4, "2026-11-15T05:00:00.000Z", "mac-unreachable")], state: { kind: "pending", attempt: 2 } };
  const pending5 = { ...run(5), history: [], state: { kind: "pending", attempt: 1 } };
  expect(parseState({ ...legacy, jobs: [green1, red2] }).mac).toEqual({ kind: "reachable" });
  const loaded = parseState({ ...legacy, jobs: [green1, red2, mac3, mac4, pending5] });
  expect(loaded.mac).toEqual({ kind: "unreachable", since: "2026-11-15T03:00:00.000Z", revision: sha(3), reportPath: "/reports/3.md", notified: false });
  expect(loaded.jobs[2]?.state).toMatchObject({ outcome: { operational: "mac-unreachable" } });
  const fake = harness([]);
  fake.mac.up = false;
  await tick(loaded, fake.adapters);
  expect(loaded.jobs.slice(3).map(job => job.state)).toEqual([{ kind: "paused", attempt: 2 }, { kind: "paused", attempt: 1 }]);
  expect(fake.dispatches).toEqual([]);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("Mac unreachable, iPhone smokes paused");
  fake.mac.up = true;
  await tick(loaded, fake.adapters);
  expect(fake.dispatches).toEqual([sha(5)]);
  expect(loaded.jobs[3]?.state).toEqual({ kind: "paused", attempt: 2 });
  expect(() => parseState({ ...legacy, mac: { kind: "unreachable", since: now } })).toThrow("Invalid Mac availability");
});

test("the Mac probe asks Tailscale first and Mesh SSH only when the Mac is listed online", () => {
  const calls: string[] = [];
  const fake = (tailscale: { status: number | null; stdout: string }, mesh: number | null) => (file: string, args: readonly string[], timeoutMs: number) => {
    calls.push(`${file} ${args.join(" ")} ${timeoutMs}`);
    return file === "tailscale" ? tailscale : { status: mesh, stdout: "" };
  };
  const online = "100.92.135.44   shauls-macbook-air       shaul9191@  macOS  active; relay \"lhr\", tx 1 rx 2\n";
  const offline = "100.92.135.44   shauls-macbook-air       shaul9191@  macOS  active; relay \"lhr\"; offline, last seen 6m ago\n";
  expect(macReachable(fake({ status: 0, stdout: offline }, 0))).toBe(false);
  expect(macReachable(fake({ status: null, stdout: "" }, 0))).toBe(false);
  expect(macReachable(fake({ status: 0, stdout: online.replace("shauls-macbook-air", "shauls-macbook-air-2") }, 0))).toBe(false);
  expect(calls.every(call => call.startsWith("tailscale status 10000"))).toBe(true);
  expect(macReachable(fake({ status: 0, stdout: online }, 1))).toBe(false);
  expect(macReachable(fake({ status: 0, stdout: online }, 0))).toBe(true);
  expect(calls.at(-1)).toBe("mesh ssh mac -- true 20000");
});

test("failed discovery keeps enrolled work and records an operational error", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  finish(state, 1);
  fake.adapters.discover = async () => { throw new Error("GitHub offline"); };
  await tick(state, fake.adapters);
  expect(state.error).toContain("GitHub offline");
  expect(state.jobs).toHaveLength(1);
  expect(fake.dispatches).toHaveLength(1);
});

function apiRun(number: number, overrides = {}) {
  return { id: 100 + number, run_number: number, workflow_id: 42, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", status: "completed", conclusion: "success", head_repository: { full_name: "ShaulLavo/bun-wasm" }, head_sha: sha(number), created_at: since, ...overrides };
}

test("GitHub adapter selects exact successful CI push/main revisions and all pages", async () => {
  const excluded = [apiRun(201, { event: "pull_request" }), apiRun(202, { conclusion: "failure" }), apiRun(203, { workflow_id: 9 }), apiRun(204, { path: ".github/workflows/release.yml" }), apiRun(205, { head_branch: "feature" }), apiRun(206, { status: "in_progress" }), apiRun(207, { head_repository: { full_name: "someone/fork" } }), apiRun(208, { created_at: "2026-11-14T12:00:00Z" })];
  const records = Array.from({ length: 101 }, (_, index) => apiRun(index + 1)).concat(excluded);
  const paths: string[] = [];
  const runs = await discover(async path => {
    paths.push(path);
    if (path.endsWith("ci.yml")) return { id: 42, path: ".github/workflows/ci.yml" };
    return { total_count: records.length, workflow_runs: path.endsWith("page=1") ? records.slice(0, 100) : records.slice(100) };
  }, since, now);
  expect(runs.map(run => run.revision)).toEqual(Array.from({ length: 101 }, (_, index) => sha(index + 1)));
  expect(paths).toHaveLength(3);
  expect(paths[1]).toContain("status=success");
});

test("GitHub 1000-run ceiling splits windows and removes boundary duplicates", async () => {
  let windows = 0;
  const runs = await discover(async path => {
    if (path.endsWith("ci.yml")) return { id: 42, path: ".github/workflows/ci.yml" };
    windows++;
    return windows === 1 ? { total_count: 1001, workflow_runs: [] } : { total_count: 1, workflow_runs: [apiRun(1)] };
  }, since, now);
  expect(windows).toBe(3);
  expect(runs.map(run => run.revision)).toEqual([sha(1)]);
});

test("malformed or incomplete inventories and contradictory results fail closed", async () => {
  await expect(discover(async path => path.endsWith("ci.yml") ? { id: 42, path: ".github/workflows/ci.yml" } : { total_count: 1, workflow_runs: [] }, since, now)).rejects.toThrow("Incomplete");
  expect(() => outcome({ revision: sha(2), status: "green", failedPhase: null, reportPath: "/r" }, sha(1))).toThrow("source differs");
  expect(() => outcome({ revision: sha(1), status: "green", failedPhase: "startup", reportPath: "/r" }, sha(1))).toThrow("Invalid");
  expect(() => parseState({ ...fresh(), jobs: [{ ...run(1), state: { kind: "running" } }] })).toThrow();
});

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bun-wasm-iphone-watch-"));
  scratch.push(path);
  return path;
}

test("durable state reload preserves jobs and cannot silently reset corrupt state", async () => {
  const path = await directory(), state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  await save(path, state);
  expect(await load(path, since)).toEqual(state);
  expect(await readFile(join(path, "STATUS.md"), "utf8")).toContain(sha(1));
  await expect(load(path, "2026-11-14T00:00:00.000Z")).rejects.toThrow("Activation differs");
  await writeFile(join(path, "state.json"), "garbage");
  await expect(load(path, since)).rejects.toThrow();
});

test("dispatch requires atomic claim, stable exact-source build, FIFO and cleanup", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  const message = instructions("/work/reports/smoke", "/work/checkout", first(state));
  for (const word of [" claim ", sha(1), "device_open", "Mac FIFO", "cleanup", " complete ", "--attempt=1", "Never substitute"]) expect(message).toContain(word);
  expect(message).toContain(`scripts/iphone-smoke-build-slot.ts /work/worktrees/bun-wasm/iphone-smoke-build ${sha(1)}`);
  expect(message).toContain("scripts/with-build-cache.sh");
  expect(message).toContain("The slot runs frozen root and Web dependency installs using the scheduled checkout's Bun settings");
  expect(message).toContain("Leave out dependency installs from copied scripts");
  expect(message).toContain("bun install --frozen-lockfile in the root and Web directories");
  expect(message).toContain("Stage prepared assets outside the build slot");
  expect(message).not.toContain("iphone-smoke-job");
});

async function cli(path: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, resolve("scripts/iphone-smoke-watch.ts")].concat(args, [`--report-dir=${path}`]), { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env }, timeout: 60_000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("watcher status runs from a builtin-only source fixture without browser packages", async () => {
  const root = await directory(), reports = join(root, "reports");
  await mkdir(reports);
  await save(reports, fresh());
  const original = await readFile(join(reports, "state.json"), "utf8");
  const project = resolve(import.meta.dir, "../..");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cold-iphone-watcher", private: true, type: "module" }));
  await cp(join(project, "scripts/iphone-smoke-watch"), join(root, "scripts/iphone-smoke-watch"), { recursive: true, filter: source => !source.endsWith(".test.ts") });
  for (const name of ["scripts/iphone-smoke-watch.ts", "scripts/iphone-smoke/cases.ts", "scripts/goals-matrix/catalog.ts", "scripts/goals-matrix/evidence.ts"]) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await copyFile(join(project, name), join(root, name));
  }
  const child = Bun.spawn([process.execPath, join(root, "scripts/iphone-smoke-watch.ts"), "status", `--report-dir=${reports}`],
    { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("# iPhone smoke automation");
  expect(await readFile(join(reports, "state.json"), "utf8")).toBe(original);
}, 60_000);

test("CLI fake GitHub/T3 dispatch, claim, red complete and cleanup-confirmed retry", async () => {
  const path = await directory(), bin = join(path, "bin");
  await mkdir(bin);
  const fixture = JSON.stringify({ total_count: 2, workflow_runs: [apiRun(1), apiRun(2)] });
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.at(-1).endsWith('ci.yml') ? {id:42,path:'.github/workflows/ci.yml'} : ${fixture}));\n`);
  await writeFile(join(bin, "t3"), `#!${process.execPath}\nawait Bun.write(process.env.SEND_LOG, (await Bun.file(process.env.SEND_LOG).exists() ? await Bun.file(process.env.SEND_LOG).text() : '') + JSON.stringify(process.argv.slice(2)) + '\\n');\nif(process.env.SEND_FAIL === '1') process.exit(1);\nconsole.log('{}');\n`);
  await chmod(join(bin, "gh"), 0o700);
  await chmod(join(bin, "t3"), 0o700);
  const env = { PATH: `${bin}:${process.env.PATH}`, T3_CLI: join(bin, "t3"), SEND_LOG: join(path, "messages.jsonl") };
  expect((await cli(path, ["tick", `--since=${since}`], env)).code).toBe(0);
  expect((await cli(path, ["tick"], env)).code).toBe(0);
  expect((await readFile(env.SEND_LOG, "utf8")).trim().split("\n")).toHaveLength(1);
  const identity = [`--revision=${sha(1)}`, "--attempt=1"];
  expect((await cli(path, ["claim"].concat(identity), env)).code).toBe(0);
  expect((await cli(path, ["claim"].concat(identity), env)).code).toBe(1);
  const result = join(path, "manual-result.json");
  const raw = JSON.stringify(tabCountReport());
  await writeFile(result, raw);
  expect((await cli(path, ["complete"].concat(identity, [`--result-file=${result}`]), { ...env, SEND_FAIL: "1" })).code).toBe(1);
  expect(first(await load(path)).state).toMatchObject({ kind: "complete", notified: false, outcome: { status: "red" } });
  expect((await cli(path, ["tick"], env)).code).toBe(0);
  expect(first(await load(path)).state).toMatchObject({ notified: true });
  expect(await readFile(join(path, "STATUS.md"), "utf8")).toContain("OPERATIONAL ALERT");
  expect(await readFile(env.SEND_LOG, "utf8")).toContain("OPERATIONAL ALERT");
  expect(await readFile(join(path, sha(1), "attempt-1", "result.json"), "utf8")).toBe(raw);
  const audit = join(path, "audit.md");
  await writeFile(audit, "No Mac work started. No resources remain.\n");
  expect((await cli(path, ["retry"].concat(identity), env)).code).toBe(1);
  expect((await cli(path, ["retry"].concat(identity, [`--cleanup-report=${audit}`]), env)).code).toBe(0);
  expect(first(await load(path)).state).toEqual({ kind: "pending", attempt: 2 });
  expect(await readFile(join(path, sha(1), "attempt-1", "result.json"), "utf8")).toContain("manual-iphone-smoke");
}, 60_000);

test("CLI red complete queues one automatic retry, and a second red notifies once", async () => {
  const path = await directory(), bin = join(path, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.at(-1).endsWith('ci.yml') ? {id:42,path:'.github/workflows/ci.yml'} : ${JSON.stringify({ total_count: 1, workflow_runs: [apiRun(1)] })}));\n`);
  await writeFile(join(bin, "t3"), `#!${process.execPath}\nawait Bun.write(process.env.SEND_LOG, (await Bun.file(process.env.SEND_LOG).exists() ? await Bun.file(process.env.SEND_LOG).text() : '') + JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('{}');\n`);
  await chmod(join(bin, "gh"), 0o700);
  await chmod(join(bin, "t3"), 0o700);
  const env = { PATH: `${bin}:${process.env.PATH}`, T3_CLI: join(bin, "t3"), SEND_LOG: join(path, "messages.jsonl") };
  const sent = async () => (await readFile(env.SEND_LOG, "utf8")).trim().split("\n");
  expect((await cli(path, ["tick", `--since=${since}`], env)).code).toBe(0);
  for (const attempt of [1, 2]) {
    const identity = [`--revision=${sha(1)}`, `--attempt=${attempt}`];
    expect((await cli(path, ["claim"].concat(identity), env)).code).toBe(0);
    const result = join(path, `red-${attempt}.json`);
    await writeFile(result, JSON.stringify(redAt(first(await load(path)), `/reports/attempt-${attempt}.json`)));
    expect((await cli(path, ["complete"].concat(identity, [`--result-file=${result}`]), env)).code).toBe(0);
    expect(await readFile(join(path, sha(1), `attempt-${attempt}`, "result.json"), "utf8")).toContain(`attempt-${attempt}.json`);
    if (attempt === 2) break;
    expect(first(await load(path)).state).toEqual({ kind: "pending", attempt: 2 });
    expect(await sent()).toHaveLength(1);
    expect((await cli(path, ["tick"], env)).code).toBe(0);
    expect((await sent()).at(-1)).toContain("attempt 2");
  }
  const messages = await sent();
  expect(messages).toHaveLength(3);
  for (const text of ["Failed twice", "/reports/attempt-1.json", "/reports/attempt-2.json"]) expect(messages[2]).toContain(text);
  expect(first(await load(path)).state).toMatchObject({ kind: "complete", attempt: 2, notified: true });
}, 60_000);

test("CLI timeout after delivery releases the lock for a waiting claim without red or a second claim", async () => {
  const path = await directory(), bin = join(path, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.at(-1).endsWith('ci.yml') ? {id:42,path:'.github/workflows/ci.yml'} : ${JSON.stringify({ total_count: 1, workflow_runs: [apiRun(1)] })}));\n`);
  await writeFile(join(bin, "t3"), `#!${process.execPath}\nimport {execFileSync} from 'node:child_process';\nawait Bun.write(process.env.SEND_LOG, (await Bun.file(process.env.SEND_LOG).exists() ? await Bun.file(process.env.SEND_LOG).text() : '') + JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv.at(-1).startsWith('Run scheduled')) {\n  await Bun.write(process.env.SEND_READY, 'delivered');\n  execFileSync('flock', [process.env.SEND_GATE, 'true']);\n  console.error('ETIMEDOUT after delivery');\n  process.exit(124);\n}\nconsole.log('{}');\n`);
  await chmod(join(bin, "gh"), 0o700);
  await chmod(join(bin, "t3"), 0o700);
  const env = { PATH: `${bin}:${process.env.PATH}`, T3_CLI: join(bin, "t3"), SEND_LOG: join(path, "messages.jsonl"), SEND_READY: join(path, "delivered"), SEND_GATE: join(path, "send-gate") };
  const holder = await holdLock(env.SEND_GATE);
  try {
    await timeoutClaim(path, env, () => holder.stdin.end());
  } finally { holder.stdin.end(); holder.kill(); await holder.exited; }
  const messages = (await readFile(env.SEND_LOG, "utf8")).trim().split("\n");
  expect(messages).toHaveLength(1);
  expect(messages[0]).not.toContain("smoke RED");
  expect(first(await load(path)).state).toMatchObject({ kind: "complete", outcome: { status: "green" } });
}, 60_000);

async function timeoutClaim(path: string, env: Record<string, string> & { SEND_READY: string }, release: () => void) {
  const ready = fileWritten(env.SEND_READY);
  const ticking = cli(path, ["tick", `--since=${since}`], env);
  let claiming: ReturnType<typeof cli> | null = null;
  try {
    await ready;
    const identity = [`--revision=${sha(1)}`, "--attempt=1"];
    claiming = cli(path, ["claim"].concat(identity), env);
    expect((await cli(path, ["tick"], env)).code).toBe(75);
    release();
    expect((await ticking).code).toBe(0);
    expect((await claiming).code).toBe(0);
    expect(first(await load(path)).state).toMatchObject({ claimedAt: expect.any(String) });
    expect((await cli(path, ["claim"].concat(identity), env)).code).toBe(1);
    expect((await cli(path, ["tick"], env)).code).toBe(0);
    const result = join(path, "green.json");
    await writeFile(result, JSON.stringify(green(first(await load(path)))));
    expect((await cli(path, ["complete"].concat(identity, [`--result-file=${result}`]), env)).code).toBe(0);
  } finally { release(); await ticking; if (claiming) await claiming; }
}

async function fileWritten(path: string): Promise<void> {
  const abort = new AbortController();
  const events = watch(dirname(path), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
  try {
    if (await Bun.file(path).exists()) return;
    for await (const event of events) { if (event.filename === basename(path)) return; }
  } finally { abort.abort(); }
}

test("CLI mac-unreachable completion pauses with one notice, then the probe resumes only the newest main", async () => {
  const path = await directory(), bin = join(path, "bin");
  await mkdir(bin);
  const runs = join(path, "runs.json");
  await writeFile(runs, JSON.stringify({ total_count: 1, workflow_runs: [apiRun(1)] }));
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconsole.log(process.argv.at(-1).endsWith('ci.yml') ? JSON.stringify({id:42,path:'.github/workflows/ci.yml'}) : await Bun.file(process.env.RUNS).text());\n`);
  await writeFile(join(bin, "t3"), `#!${process.execPath}\nawait Bun.write(process.env.SEND_LOG, (await Bun.file(process.env.SEND_LOG).exists() ? await Bun.file(process.env.SEND_LOG).text() : '') + JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('{}');\n`);
  await writeFile(join(bin, "tailscale"), `#!${process.execPath}\nawait Bun.write(process.env.PROBES, (await Bun.file(process.env.PROBES).exists() ? await Bun.file(process.env.PROBES).text() : '') + 'tailscale\\n');\nconsole.log('100.92.135.44   shauls-macbook-air   shaul9191@  macOS  active' + (await Bun.file(process.env.MAC_UP).exists() ? ', tx 1 rx 2' : '; offline, last seen 6m ago'));\n`);
  await writeFile(join(bin, "mesh"), `#!${process.execPath}\nawait Bun.write(process.env.PROBES, (await Bun.file(process.env.PROBES).exists() ? await Bun.file(process.env.PROBES).text() : '') + process.argv.slice(2).join(' ') + '\\n');\n`);
  for (const name of ["gh", "t3", "tailscale", "mesh"]) await chmod(join(bin, name), 0o700);
  const env = { PATH: `${bin}:${process.env.PATH}`, T3_CLI: join(bin, "t3"), SEND_LOG: join(path, "messages.jsonl"), RUNS: runs, PROBES: join(path, "probes.log"), MAC_UP: join(path, "mac-up") };
  const sent = async () => (await readFile(env.SEND_LOG, "utf8")).trim().split("\n").map(line => JSON.parse(line).at(-1) as string);
  expect((await cli(path, ["tick", `--since=${since}`], env)).code).toBe(0);
  const identity = [`--revision=${sha(1)}`, "--attempt=1"];
  expect((await cli(path, ["claim"].concat(identity), env)).code).toBe(0);
  const result = join(path, "mac.json");
  await writeFile(result, JSON.stringify({ kind: "manual-iphone-smoke", revision: sha(1), status: "red", failedPhase: "mac-unreachable", reportPath: "/reports/mac.md", cases: [] }));
  expect((await cli(path, ["complete"].concat(identity, [`--result-file=${result}`]), env)).code).toBe(0);
  expect((await sent()).slice(1)).toEqual([expect.stringContaining("Mac unreachable, iPhone smokes paused")]);
  await writeFile(runs, JSON.stringify({ total_count: 3, workflow_runs: [apiRun(1), apiRun(2), apiRun(3)] }));
  expect((await cli(path, ["tick"], env)).code).toBe(0);
  expect(await sent()).toHaveLength(2);
  expect(await readFile(env.PROBES, "utf8")).toBe("tailscale\n");
  expect((await load(path)).jobs.map(job => job.state.kind)).toEqual(["complete", "paused", "paused"]);
  expect(await readFile(join(path, "STATUS.md"), "utf8")).toContain("smokes paused; pause notice sent");
  await writeFile(env.MAC_UP, "");
  expect((await cli(path, ["tick"], env)).code).toBe(0);
  expect(await readFile(env.PROBES, "utf8")).toBe("tailscale\ntailscale\nssh mac -- true\n");
  const messages = await sent();
  expect(messages).toHaveLength(4);
  expect(messages.some(message => message.includes("smoke RED"))).toBe(false);
  expect(messages.slice(2).map(message => message.slice(0, 40)).toSorted()).toEqual(["Run scheduled iPhone smoke for exact suc", "iPhone smoke: Mac back, smokes resumed. "]);
  expect(messages.findLast(message => message.startsWith("Run scheduled"))).toContain(sha(3));
  expect((await load(path)).jobs.map(job => job.state.kind)).toEqual(["complete", "paused", "running"]);
}, 60_000);

test("claim and complete survive a busy watcher lock while duplicate claims stay rejected", async () => {
  const path = await directory(), state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  await save(path, state);
  const identity = [`--revision=${sha(1)}`, "--attempt=1"];
  expect((await contendedCli(path, ["claim"].concat(identity))).code).toBe(0);
  expect(first(await load(path)).state).toMatchObject({ kind: "running", claimedAt: expect.any(String) });
  expect((await cli(path, ["claim"].concat(identity))).code).toBe(1);
  const result = join(path, "manual-result.json");
  await writeFile(result, JSON.stringify(green(first(await load(path)))));
  expect((await contendedCli(path, ["complete"].concat(identity, [`--result-file=${result}`]))).code).toBe(0);
  expect(first(await load(path)).state).toMatchObject({ kind: "complete", outcome: { status: "green" } });
}, 60_000);

async function contendedCli(path: string, args: string[]) {
  const holder = await holdLock(join(path, ".lock"));
  try {
    const release = Bun.sleep(500).then(() => holder.stdin.end());
    const result = await cli(path, args);
    await release;
    return result;
  } finally { holder.stdin.end(); holder.kill(); await holder.exited; }
}

async function holdLock(path: string) {
  const holder = Bun.spawn(["flock", path, process.execPath, "--eval", 'process.stdout.write("held\\n"); await new Response(Bun.stdin).text();'], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const reader = holder.stdout.getReader();
  try { expect((await reader.read()).done).toBe(false); }
  catch (error) { holder.stdin.end(); holder.kill(); await holder.exited; throw error; }
  finally { reader.releaseLock(); }
  return holder;
}
