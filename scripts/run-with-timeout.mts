import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { constants } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type ProcessIdentity = { pid: number; parent: number; group: number; session: number; birth: string; state: string };
const [seconds, command, ...args] = process.argv.slice(2);
const timeout = Number(seconds) * 1000;
if (!command || !Number.isFinite(timeout) || timeout <= 0) {
  throw new Error("Usage: run-with-timeout.mts <seconds> <command> [args...]");
}
const marker = `BUN_WASM_DEADLINE_${randomUUID().replaceAll("-", "")}`;
const owned = new Map<number, ProcessIdentity>();
let root: ProcessIdentity | undefined;
let timedOut = false;
let interrupted: number | undefined;
let stopping: Promise<void> | undefined;

function linuxProcess(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [state, parent, group, session] = fields;
    const birth = fields[19];
    if (!state || !birth) throw new Error(`invalid process identity for ${pid}`);
    return { pid, parent: Number(parent), group: Number(group), session: Number(session), birth, state };
  } catch (error) {
    if (isGone(error)) return undefined;
    throw error;
  }
}
function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
function snapshot(): ProcessIdentity[] {
  if (process.platform === "linux") return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => linuxProcess(Number(name)) ?? []);
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,sess=,lstart=,stat="], { encoding: "utf8", timeout: 2000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`process snapshot failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").map(line => {
    const [pid, parent, group, session, ...rest] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), session: Number(session), birth: rest.slice(0, 5).join(" "), state: rest[5] ?? "" };
  });
}
function marked(row: ProcessIdentity): boolean {
  if (process.platform !== "linux") return false;
  try { return readFileSync(`/proc/${row.pid}/environ`, "utf8").split("\0").includes(`${marker}=1`); }
  catch (error) {
    if (isGone(error) || error instanceof Error && "code" in error && error.code === "EACCES") return false;
    throw error;
  }
}
function ownedSessionLeader(row: ProcessIdentity, current: ReadonlyMap<number, ProcessIdentity>): ProcessIdentity | undefined {
  if (process.platform !== "linux" || !root) return undefined;
  const leader = current.get(row.session);
  if (!leader || leader.pid !== leader.group || leader.pid !== leader.session) return undefined;
  if (Number(leader.birth) < Number(root.birth)) return undefined;
  return leader;
}
function capture(includeOrphans = false): ProcessIdentity[] {
  const rows = snapshot();
  const current = new Map(rows.map(row => [row.pid, row]));
  const pending = rows.filter(row => owned.get(row.pid)?.birth === row.birth || includeOrphans && marked(row));
  // A browser leader can hide its environment; a marked member still identifies its newly-created session.
  pending.push(...pending.flatMap(row => ownedSessionLeader(row, current) ?? []));
  if (root && current.get(root.pid)?.birth === root.birth) pending.push(root);
  const found = new Set<number>();
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row || found.has(row.pid)) continue;
    found.add(row.pid);
    owned.set(row.pid, row);
    pending.push(...rows.filter(candidate => candidate.parent === row.pid));
  }
  return rows.filter(row => owned.get(row.pid)?.birth === row.birth && row.state !== "Z");
}
function signalOwned(signal: NodeJS.Signals) {
  const current = process.platform === "linux" ? undefined : new Map(snapshot().map(row => [row.pid, row]));
  for (const row of owned.values()) {
    const now = process.platform === "linux" ? linuxProcess(row.pid) : current?.get(row.pid);
    if (!now || now.birth !== row.birth || now.state === "Z") continue;
    try { process.kill(row.pid, signal); }
    catch (error) { if (!isGone(error)) throw error; }
  }
}
async function teardown() {
  capture(true);
  signalOwned("SIGTERM");
  const grace = performance.now() + 5000;
  while (capture(true).length > 0 && performance.now() < grace) await delay(25);
  const forced = performance.now() + 2000;
  while (capture(true).length > 0 && performance.now() < forced) {
    signalOwned("SIGKILL");
    await delay(25);
  }
  const remaining = capture(true);
  if (remaining.length > 0) throw new Error(`owned processes survived teardown: ${remaining.map(row => `${row.pid}@${row.birth}`).join(", ")}`);
}
function stop(): Promise<void> {
  stopping ??= teardown();
  void stopping.catch(() => {});
  return stopping;
}
function commandLine(pid: number): string {
  if (process.platform !== "linux") return "";
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(); }
  catch (error) { if (isGone(error)) return ""; throw error; }
}
function diagnoseTimeout() {
  console.error(`command deadline exceeded after ${seconds}s: ${command} ${args.join(" ")}`);
  console.error(`owned process group ${root?.pid ?? "not started"} and detached descendants (pid ppid pgid state birth):`);
  for (const row of capture(true)) console.error(`${row.pid} ${row.parent} ${row.group} ${row.state} ${row.birth} ${commandLine(row.pid)}`);
}
const handlers = ([ ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129] ] as const).map(([signal, code]) => {
  const handler = () => { interrupted ??= code; void stop(); };
  process.on(signal, handler);
  return { signal, handler };
});
let tracker: ReturnType<typeof setInterval> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const child = spawn(command, args, { stdio: "inherit", detached: true, env: { ...process.env, [marker]: "1" } });
  if (child.pid !== undefined) {
    root = snapshot().find(row => row.pid === child.pid && row.parent === process.pid);
    capture(true);
  }
  tracker = setInterval(() => capture(), 50);
  timer = setTimeout(() => {
    timedOut = true;
    diagnoseTimeout();
    void stop();
  }, timeout);
  const status = await new Promise<number>(resolve => {
    child.once("error", (error: NodeJS.ErrnoException) => { console.error(error.message); resolve(error.code === "ENOENT" ? 127 : 126); });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
  clearTimeout(timer);
  await stop();
  process.exitCode = timedOut ? 124 : interrupted ?? status;
} finally {
  clearTimeout(timer);
  clearInterval(tracker);
  try { await stop(); }
  finally { for (const { signal, handler } of handlers) process.off(signal, handler); }
}
