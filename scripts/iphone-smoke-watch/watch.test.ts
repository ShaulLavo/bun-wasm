import { afterEach, expect, test } from "bun:test";
import "../iphone-smoke-watch";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { instructions } from "./dispatch";
import { discover } from "./github";
import { outcome, state as parseState, type Job, type Run, type State } from "./model";
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
  const adapters: Adapters = {
    discover: async () => runs,
    save: async value => { snapshots.push(structuredClone(value)); },
    dispatch: async job => { dispatches.push(job.revision); },
    notify: async message => { messages.push(message); },
    now: () => now,
  };
  return { adapters, snapshots, dispatches, messages };
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
  expect(fake.snapshots.find(snapshot => first(snapshot).state.kind === "running")?.jobs[0]?.state).toMatchObject({ dispatch: "pending" });
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

test("failed dispatch remains pending and retries without inventing delivery", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.dispatch = async () => { throw new Error("T3 unavailable"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("T3 unavailable");
  expect(first(state).state).toMatchObject({ kind: "running", dispatch: "pending" });
  fake.adapters.dispatch = async job => { fake.dispatches.push(job.revision); };
  await tick(state, fake.adapters);
  expect(first(state).state).toMatchObject({ dispatch: "sent" });
  expect(fake.dispatches).toEqual([sha(1)]);
});

test("an interrupted save before dispatch cannot launch a job", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.save = async value => { if (first(value).state.kind === "running") throw new Error("disk interrupted"); };
  await expect(tick(state, fake.adapters)).rejects.toThrow("disk interrupted");
  expect(fake.dispatches).toEqual([]);
});

test("crash after send can replay its outbox but cannot claim a second UI job", async () => {
  const state = fresh(), fake = harness([run(1)]);
  fake.adapters.save = async value => {
    const progress = first(value).state;
    if (progress.kind === "running" && progress.dispatch === "sent") throw new Error("ack save interrupted");
    fake.snapshots.push(structuredClone(value));
  };
  await expect(tick(state, fake.adapters)).rejects.toThrow("ack save interrupted");
  const persisted = fake.snapshots.at(-1);
  if (!persisted) throw new Error("Expected durable dispatch intent");
  expect(first(persisted).state).toMatchObject({ dispatch: "pending" });
  fake.adapters.save = async () => {};
  await tick(persisted, fake.adapters);
  expect(fake.dispatches).toEqual([sha(1), sha(1)]);
  claim(first(persisted), 1, now);
  expect(() => claim(first(persisted), 1, now)).toThrow("already claimed");
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
  const child = Bun.spawn([process.execPath, resolve("scripts/iphone-smoke-watch.ts")].concat(args, [`--report-dir=${path}`]), { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
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
  const holder = Bun.spawn(["flock", join(path, ".lock"), process.execPath, "--eval", 'process.stdout.write("held\\n"); await new Response(Bun.stdin).text();'], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const reader = holder.stdout.getReader();
  try {
    expect((await reader.read()).done).toBe(false);
    const release = Bun.sleep(500).then(() => holder.stdin.end());
    const result = await cli(path, args);
    await release;
    return result;
  } finally { reader.releaseLock(); holder.stdin.end(); holder.kill(); await holder.exited; }
}
