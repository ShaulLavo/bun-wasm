import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { ProcessOwner, linuxProcess } from "./process-owner.mts";
import { testSubreaper } from "./test-subreaper.ts";

export function runSubreaperProbe(args: readonly string[], timeout = 30000) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), String(timeout)].concat(args), { encoding: "utf8", timeout });
}

async function executeProbe(args: readonly string[], timeout: number, wait: (pid: number) => number): Promise<number> {
  const owner = new ProcessOwner();
  let interrupted = 0;
  let reapingFailure: unknown;
  let stop = () => {};
  const aborted = new Promise<void>(resolve => { stop = resolve; });
  const interrupt = (code: number) => { interrupted ||= code; stop(); };
  const handlers = ([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const).map(([signal, code]) => {
    const handler = () => interrupt(code);
    process.on(signal, handler);
    return { signal, handler };
  });
  const child = spawn(process.execPath, args, { stdio: "inherit", detached: true });
  if (child.pid !== undefined) owner.adopt(child.pid);
  function reap() {
    owner.capture();
    for (const row of owner.owned.values()) {
      const now = linuxProcess(row.pid);
      if (row.pid === child.pid || now?.birth !== row.birth || now.parent !== process.pid || now.state !== "Z") continue;
      if (wait(row.pid) < 0 && linuxProcess(row.pid)?.birth === row.birth) throw new Error(`Cannot reap probe descendant ${row.pid}`);
    }
  }
  async function drain() {
    const survivors = await owner.drain({ graceMs: 0, forceMs: 2000 });
    reap();
    if (survivors.length) throw new Error("Probe descendants survived cleanup");
  }
  const tracker = setInterval(() => {
    try { reap(); }
    catch (error) { reapingFailure ??= error; interrupt(1); }
  }, 20);
  const deadline = setTimeout(() => interrupt(124), timeout);
  const exited = new Promise<number>(resolve => {
    child.once("error", error => { console.error(error.message); resolve(127); });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
  try {
    await Promise.race([exited, aborted]);
    await drain();
    const status = await exited;
    reap();
    if (reapingFailure) throw reapingFailure;
    return interrupted || status;
  } finally {
    clearInterval(tracker);
    clearTimeout(deadline);
    try { await drain(); }
    finally { for (const { signal, handler } of handlers) process.off(signal, handler); }
  }
}

async function supervise(args: readonly string[], timeout: number): Promise<number> {
  const { dlopen } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" } });
  const status = new Int32Array(1);
  let restore = () => {};
  try {
    restore = await testSubreaper(true);
    return await executeProbe(args, timeout, pid => libc.symbols.waitpid(pid, status, 1));
  } finally { try { restore(); } finally { libc.close(); } }
}

if (import.meta.main) {
  const [budget, ...args] = process.argv.slice(2);
  const timeout = Number(budget);
  if (!Number.isFinite(timeout) || timeout <= 0 || !args.length) throw new Error("Missing probe timeout or command");
  process.exitCode = await supervise(args, timeout);
}
