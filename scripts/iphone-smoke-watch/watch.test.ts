import { afterEach, expect, test } from "bun:test";
import "../iphone-smoke-watch";
import { chmod, mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { instructions } from "./dispatch";
import { discover } from "./github";
import { claimWindowMs, outcome, state as parseState, type Job, type Run, type State } from "./model";
import { claim, complete, retry, tick, type Adapters } from "./scheduler";
import { load, save } from "./storage";

const since = "2026-11-15T00:00:00.000Z";
const now = "2026-11-15T12:00:00.000Z";
const sha = (number: number) => number.toString(16).padStart(40, "0");
const run = (number: number): Run => ({ revision: sha(number), id: number + 100, number, createdAt: since });
const fresh = (): State => ({ schema: 1, since, polledAt: null, error: null, jobs: [] });
const green = (job: Job) => outcome({ revision: job.revision, status: "green", failedPhase: null, reportPath: "/reports/result.json" }, job.revision);
const red = (job: Job) => outcome({ revision: job.revision, status: "red", failedPhase: "prepare-artifacts", reportPath: "/reports/failure.md" }, job.revision);

function harness(runs: Run[]) {
  const snapshots: State[] = [], dispatches: string[] = [], messages: string[] = [];
  let clock = Date.parse(now);
  const adapters: Adapters = {
    discover: async () => runs,
    save: async value => { snapshots.push(structuredClone(value)); },
    dispatch: async job => { dispatches.push(job.revision); },
    notify: async message => { messages.push(message); },
    now: () => new Date(clock).toISOString(),
  };
  return { adapters, snapshots, dispatches, messages, advance: (ms: number) => { clock += ms; } };
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
  complete(first(state), red(first(state)), fake.adapters.now());
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toContain("smoke RED");
  expect(fake.messages[0]).toContain("prepare-artifacts");
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
  complete(first(state), red(first(state)), fake.adapters.now());
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
  await tick(state, fake.adapters);
  expect(fake.messages).toHaveLength(1);
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

test("dispatch requires atomic claim, exact-source preparation, FIFO and cleanup", async () => {
  const state = fresh(), fake = harness([run(1)]);
  await tick(state, fake.adapters);
  const message = instructions("/work/reports/smoke", "/work/checkout", first(state));
  for (const word of [" claim ", sha(1), "device_open", "Mac FIFO", "cleanup", " complete ", "--attempt=1", "Never substitute"]) expect(message).toContain(word);
  expect(message).not.toContain("iphone-smoke-job");
});

async function cli(path: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, resolve("scripts/iphone-smoke-watch.ts")].concat(args, [`--report-dir=${path}`]), { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env }, timeout: 60_000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

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
  await writeFile(result, JSON.stringify({ kind: "manual-iphone-smoke", revision: sha(1), source: {}, status: "red", failedPhase: "prepare", reportPath: result, cases: [], ownership: {} }));
  expect((await cli(path, ["complete"].concat(identity, [`--result-file=${result}`]), { ...env, SEND_FAIL: "1" })).code).toBe(1);
  expect(first(await load(path)).state).toMatchObject({ kind: "complete", notified: false, outcome: { status: "red" } });
  expect((await cli(path, ["tick"], env)).code).toBe(0);
  expect(first(await load(path)).state).toMatchObject({ notified: true });
  const audit = join(path, "audit.md");
  await writeFile(audit, "No Mac work started. No resources remain.\n");
  expect((await cli(path, ["retry"].concat(identity), env)).code).toBe(1);
  expect((await cli(path, ["retry"].concat(identity, [`--cleanup-report=${audit}`]), env)).code).toBe(0);
  expect(first(await load(path)).state).toEqual({ kind: "pending", attempt: 2 });
  expect(await readFile(join(path, sha(1), "attempt-1", "result.json"), "utf8")).toContain("manual-iphone-smoke");
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
