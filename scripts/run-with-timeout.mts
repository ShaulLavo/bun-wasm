// Portable POSIX test command deadline, including command-owned descendants.
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";

const [seconds, command, ...args] = process.argv.slice(2);
const timeout = Number(seconds) * 1000;
if (!command || !Number.isFinite(timeout) || timeout <= 0) {
  throw new Error("Usage: run-with-timeout.mts <seconds> <command> [args...]");
}
const child = spawn(command, args, { stdio: "inherit", detached: true });
let timedOut = false;
let interrupted: number | undefined;
function stop(signal: NodeJS.Signals = "SIGKILL") {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
const handlers = ([ ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129] ] as const).map(([signal, code]) => {
  const handler = () => { interrupted = code; stop(); };
  process.on(signal, handler);
  return { signal, handler };
});
function diagnoseTimeout() {
  console.error(`command deadline exceeded after ${seconds}s: ${command} ${args.join(" ")}`);
  console.error(`owned process group ${child.pid ?? "not started"} (pid ppid pgid state elapsed command):`);
  const snapshot = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,etime=,args="], {
    encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024,
  });
  if (snapshot.error) { console.error(`process diagnostics failed: ${snapshot.error.message}`); return; }
  for (const line of snapshot.stdout.split("\n")) {
    if (Number(line.trim().split(/\s+/)[2]) === child.pid) console.error(line);
  }
}
let escalation: ReturnType<typeof setTimeout> | undefined;
const timer = setTimeout(() => {
  timedOut = true;
  diagnoseTimeout();
  stop("SIGTERM");
  escalation = setTimeout(() => stop(), 5000);
}, timeout);
try {
  const status = await new Promise<number>(resolve => {
    child.once("error", (error: NodeJS.ErrnoException) => { console.error(error.message); resolve(error.code === "ENOENT" ? 127 : 126); });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
  process.exitCode = timedOut ? 124 : interrupted ?? status;
} finally {
  clearTimeout(timer);
  clearTimeout(escalation);
  for (const { signal, handler } of handlers) process.off(signal, handler);
  // The command may exit before descendants which inherited its stdio or sockets.
  stop();
}
