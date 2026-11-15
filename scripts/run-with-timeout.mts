import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { enableSubreaper } from "./linux-subreaper.mts";
import { ProcessOwner, describe, isGone, linuxProcess } from "./process-owner.mts";

// waitpid must run in the adopting supervisor, so Linux keeps Bun's FFI available.
function linuxSupervisorRuntime(): void {
  if (process.platform !== "linux" || process.versions.bun) return;
  const executable = spawnSync("bun", ["-p", "process.execPath"], { encoding: "utf8" });
  if (executable.error) throw executable.error;
  if (executable.status !== 0) throw new Error(`cannot locate Bun for Linux supervision: ${executable.stderr}`);
  const bun = executable.stdout.trim();
  process.execve?.(bun, [bun, import.meta.filename].concat(process.argv.slice(2)), process.env);
  throw new Error("Linux deadline supervision requires process.execve");
}

linuxSupervisorRuntime();
await enableSubreaper();

const inputs = process.argv.slice(2);
const state = inputs[0] === "--state" ? inputs[1] : undefined;
if (inputs[0] === "--state") {
  if (!state || process.platform !== "linux") throw new Error("Background state requires a directory and Linux process identity");
  inputs.splice(0, 2);
}
const [seconds, command, ...args] = inputs;
const timeout = seconds === "--until-exit" ? undefined : Number(seconds) * 1000;
if (!command || timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
  throw new Error("Usage: run-with-timeout.mts [--state <directory>] <seconds|--until-exit> <command> [args...]");
}
const owner = new ProcessOwner();
const libc = process.platform === "linux" ? (await import("bun:ffi")).dlopen("libc.so.6", {
  waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
}) : undefined;
const waitStatus = new Int32Array(1);
let rootPid: number | undefined;
let trackingFailure: unknown;
let timedOut = false;
let interrupted: number | undefined;
let stopping: Promise<void> | undefined;

async function teardown() {
  const remaining = await owner.drain({ graceMs: 5000, forceMs: 2000 });
  captureOwned();
  if (remaining.length > 0) throw new Error(`owned processes survived teardown: ${describe(remaining)}`);
}

function captureOwned(): void {
  owner.capture();
  if (!libc) return;
  for (const row of owner.owned.values()) {
    if (row.pid === rootPid || row.parent !== process.pid || row.state !== "Z") continue;
    const now = linuxProcess(row.pid);
    // Bun owns the direct child's exit event. Only our adopted, dead children are waitable here.
    if (now?.birth !== row.birth || now.parent !== process.pid || now.state !== "Z") continue;
    if (libc.symbols.waitpid(row.pid, waitStatus, 1) < 0 && linuxProcess(row.pid)?.birth === row.birth) throw new Error(`Cannot reap owned supervisor descendant ${row.pid}`);
  }
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
  console.error(`owned process group ${rootPid ?? "not started"} and detached descendants (pid ppid pgid state birth):`);
  for (const row of owner.capture()) console.error(`${row.pid} ${row.parent} ${row.group} ${row.state} ${row.birth} ${commandLine(row.pid)}`);
}
const handlers = ([ ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129] ] as const).map(([signal, code]) => {
  const handler = () => { interrupted ??= code; void stop(); };
  process.on(signal, handler);
  return { signal, handler };
});
let tracker: ReturnType<typeof setInterval> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
function receipt(name: string, contents: string) {
  if (!state) return;
  const path = join(state, name);
  writeFileSync(`${path}.tmp`, contents);
  renameSync(`${path}.tmp`, path);
}
async function execute(command: string): Promise<number> {
  if (state && existsSync(join(state, "stop"))) return 143;
  const child = spawn(command, args, { stdio: "inherit", detached: true });
  rootPid = child.pid;
  if (rootPid !== undefined) owner.adopt(rootPid);
  tracker = setInterval(() => {
    try { captureOwned(); }
    catch (error) { trackingFailure ??= error; void stop(); }
    if (!state || !existsSync(join(state, "stop"))) return;
    interrupted ??= 143;
    void stop();
  }, 50);
  if (timeout !== undefined) timer = setTimeout(() => {
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
  if (trackingFailure) throw trackingFailure;
  return timedOut ? 124 : interrupted ?? status;
}
try {
  if (state) receipt("identity.json", JSON.stringify(linuxProcess(process.pid)));
  process.exitCode = await execute(command);
} finally {
  clearTimeout(timer);
  clearInterval(tracker);
  try {
    await stop();
    receipt("status", `${process.exitCode ?? 1}\n`);
  }
  finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
    libc?.close();
  }
}
