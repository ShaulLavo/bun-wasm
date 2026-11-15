import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attemptDirectory, coordinator, dispatchFailure, instructions, managing } from "./iphone-smoke-watch/dispatch";
import { discover } from "./iphone-smoke-watch/github";
import { integer, outcome, redMessage, revision, timestamp, type Job, type State } from "./iphone-smoke-watch/model";
import { claim, complete, retry, status, tick } from "./iphone-smoke-watch/scheduler";
import { atomic, load, save } from "./iphone-smoke-watch/storage";

const defaultDirectory = "/work/reports/goals/iphone-smoke";
type Options = { command: string; values: Map<string, string>; underLock: boolean };

function options(args: readonly string[]): Options {
  const command = args[0] ?? "status";
  if (!["tick", "status", "claim", "complete", "retry"].includes(command)) throw new Error("Expected tick, status, claim, complete or retry");
  const values = new Map<string, string>();
  let underLock = false;
  for (const argument of args.slice(1)) {
    if (argument === "--under-lock") { underLock = true; continue; }
    const match = /^--(report-dir|since|revision|attempt|result-file|cleanup-report|dispatch-thread|notify-thread)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || values.has(match[1])) throw new Error(`Invalid or repeated option: ${argument}`);
    values.set(match[1], match[2]);
  }
  return { command, values, underLock };
}

function required(config: Options, key: string): string {
  const value = config.values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function selected(state: State, config: Options): Job {
  const source = revision(required(config, "revision"));
  const attempt = integer(Number(required(config, "attempt")));
  const job = state.jobs.find(job => job.revision === source);
  if (!job || job.state.attempt !== attempt) throw new Error("Unknown source or stale attempt");
  return job;
}

function send(thread: string, message: string): void {
  execFileSync(process.env.T3_CLI ?? "/home/shaul/.local/bin/t3", ["thread", "send", "--json", thread, message], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

async function dispatch(directory: string, checkout: string, thread: string, job: Job): Promise<void> {
  const output = attemptDirectory(directory, job);
  await mkdir(output, { recursive: true });
  const message = instructions(directory, checkout, job);
  await atomic(join(output, "dispatch.txt"), message + "\n");
  send(thread, message);
}

async function finish(directory: string, state: State, config: Options): Promise<void> {
  const job = selected(state, config);
  const contents = await readFile(required(config, "result-file"), "utf8");
  const result = outcome(JSON.parse(contents), job.revision);
  complete(job, result, new Date().toISOString());
  const output = attemptDirectory(directory, job);
  await mkdir(output, { recursive: true });
  await atomic(join(output, "result.json"), contents);
}

async function restart(directory: string, state: State, config: Options): Promise<void> {
  const job = selected(state, config);
  const report = await readFile(required(config, "cleanup-report"), "utf8");
  if (!report.trim()) throw new Error("A nonempty resource cleanup audit is required before retry");
  const output = attemptDirectory(directory, job);
  await mkdir(output, { recursive: true });
  await atomic(join(output, "cleanup-before-retry.txt"), report);
  await atomic(join(output, "state-before-retry.json"), JSON.stringify(job, null, 2) + "\n");
  retry(job);
}

async function poll(directory: string, state: State, config: Options): Promise<void> {
  const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const notifyThread = config.values.get("notify-thread") ?? managing;
  try {
    await tick(state, {
      discover: () => discover(async path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })), state.since, new Date().toISOString()),
      save: value => save(directory, value),
      dispatch: job => dispatch(directory, checkout, config.values.get("dispatch-thread") ?? coordinator, job),
      notify: async message => { send(notifyThread, message); },
      now: () => new Date().toISOString(),
    });
  } catch (error) {
    state.error = String(error);
    await save(directory, state);
    const active = state.jobs.find(job => job.state.kind === "running" && job.state.dispatch === "pending");
    if (active) send(notifyThread, dispatchFailure(active, directory));
    throw error;
  }
}

async function run(config: Options, directory: string): Promise<void> {
  const activation = config.values.get("since");
  const state = await load(directory, activation ? timestamp(activation) : undefined);
  if (config.command === "status") { process.stdout.write(status(state)); return; }
  if (config.command === "claim") claim(selected(state, config), integer(Number(required(config, "attempt"))), new Date().toISOString());
  if (config.command === "complete") await finish(directory, state, config);
  if (config.command === "retry") await restart(directory, state, config);
  await save(directory, state);
  if (config.command === "tick") await poll(directory, state, config);
  if (config.command === "complete") await deliver(directory, state, config);
  process.stdout.write(status(state));
}

async function deliver(directory: string, state: State, config: Options): Promise<void> {
  const job = selected(state, config);
  if (job.state.kind !== "complete" || job.state.notified) return;
  send(config.values.get("notify-thread") ?? managing, redMessage(job, job.state));
  job.state.notified = true;
  await save(directory, state);
}

async function main(args: readonly string[]): Promise<void> {
  const config = options(args);
  const directory = config.values.get("report-dir") ?? defaultDirectory;
  if (!isAbsolute(directory)) throw new Error("--report-dir must be absolute");
  await mkdir(directory, { recursive: true });
  if (config.underLock) { await run(config, directory); return; }
  const locking = config.command === "tick" ? ["--nonblock"] : ["--wait", "900"];
  const child = spawnSync("flock", locking.concat(["--conflict-exit-code", "75", join(directory, ".lock"), process.execPath, fileURLToPath(import.meta.url)], args, ["--under-lock"]), { stdio: "inherit" });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
