import type { ChildProcess } from "node:child_process";

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (pid === process.pid) throw new Error("Refusing to stop the runner's own process group");
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>(resolve => child.once("exit", () => resolve()));
  if (!signalGroup(pid, "SIGTERM")) { await exited; return; }
  const until = Date.now() + 5000;
  while (signalGroup(pid, 0) && Date.now() < until) await Bun.sleep(20);
  if (!signalGroup(pid, 0)) { await exited; return; }
  signalGroup(pid, "SIGKILL");
  await exited;
  const killedUntil = Date.now() + 5000;
  while (signalGroup(pid, 0) && Date.now() < killedUntil) await Bun.sleep(20);
  if (signalGroup(pid, 0)) throw new Error(`Process group ${pid} survived SIGKILL`);
}
