import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Identity = { pid: number; group: number; session: number; birth: string };
function optional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return undefined;
    throw error;
  }
}
function identity(state: string): Identity | undefined {
  const source = optional(join(state, "identity.json"));
  if (source === undefined) return undefined;
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null) throw new Error("Invalid JSC supervisor identity");
  if (!("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw new Error("Invalid JSC supervisor PID");
  if (!("group" in value) || value.group !== value.pid || !("session" in value) || value.session !== value.pid) throw new Error("Invalid JSC supervisor group or session");
  if (!("birth" in value) || typeof value.birth !== "string" || !/^\d+$/.test(value.birth)) throw new Error("Invalid JSC supervisor start identity");
  return { pid: value.pid, group: value.group, session: value.session, birth: value.birth };
}
function alive(record: Identity): boolean {
  const stat = optional(`/proc/${record.pid}/stat`);
  if (stat === undefined) return false;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[0] !== "Z" && Number(fields[2]) === record.group && Number(fields[3]) === record.session && fields[19] === record.birth;
}
function status(state: string): number | undefined {
  const value = optional(join(state, "status"));
  if (value === undefined) return undefined;
  if (!/^\d+\n?$/.test(value) || Number(value) > 255) throw new Error("Invalid JSC supervisor completion status");
  return Number(value);
}
async function wait(state: string, starting = false): Promise<number> {
  const startupDeadline = performance.now() + 10000;
  for (;;) {
    const record = identity(state);
    const live = record && alive(record);
    const completed = status(state);
    if (completed !== undefined) return completed;
    if (record && !live) throw new Error("JSC supervisor identity is no longer live and no completion status was written");
    if (starting && record) return 0;
    if (!record && (!starting || performance.now() >= startupDeadline)) throw new Error("JSC supervisor did not register its identity");
    await delay(50);
  }
}
async function stop(state: string): Promise<void> {
  try { writeFileSync(join(state, "stop"), "stop\n"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const deadline = performance.now() + 10000;
  while (status(state) === undefined) {
    const record = identity(state);
    if (record && !alive(record)) return;
    if (performance.now() >= deadline) throw new Error("JSC supervisor did not finish teardown");
    await delay(50);
  }
}
async function start(state: string, args: string[]): Promise<number> {
  mkdirSync(state);
  const log = openSync(join(state, "build.log"), "wx");
  try {
    const supervisor = fileURLToPath(new URL("./run-with-timeout.mts", import.meta.url));
    const child = spawn("node", [supervisor, "--state", state].concat(args), { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await wait(state, true);
    return 0;
  } catch (error) {
    writeFileSync(join(state, "stop"), "stop\n");
    process.stderr.write(optional(join(state, "build.log")) ?? "");
    throw error;
  } finally { closeSync(log); }
}
const [mode, directory, ...args] = process.argv.slice(2);
if (!directory || !["start", "wait", "stop"].includes(mode ?? "")) throw new Error("Usage: ci-jsc-worker.ts <start|wait|stop> <directory> [seconds command args...]");
const state = resolve(directory);
if (mode === "start") process.exitCode = await start(state, args);
if (mode === "stop") await stop(state);
if (mode === "wait") {
  try { process.exitCode = await wait(state); }
  finally { process.stdout.write(optional(join(state, "build.log")) ?? ""); }
}
