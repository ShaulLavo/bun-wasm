import type { ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { enableSubreaper } from "./linux-subreaper.mts";
import { linuxProcess, type ProcessIdentity } from "./process-owner.mts";
import { stopProcessGroup } from "../web/tests/next-framework-process.ts";

/** Reap only adopted grandchildren in these detached groups. Bun owns direct-child wait events. */
export async function withConsumerGroups<T>(children: readonly ChildProcess[], operation: () => Promise<T>): Promise<T> {
  if (process.platform !== "linux") return operation();
  const groups = new Set(children.flatMap(child => child.pid === undefined ? [] : [child.pid]));
  for (const pid of groups) {
    const leader = linuxProcess(pid);
    if (pid === process.pid || leader && (leader.parent !== process.pid || leader.group !== pid)) throw new Error(`Consumer child ${pid} is not an owned detached group`);
  }
  await enableSubreaper();
  const { dlopen } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" } });
  const owned = new Map<number, ProcessIdentity>();
  const status = new Int32Array(1);
  let reapingFailure: unknown;
  const capture = () => {
    try { reapGroups(groups, owned, pid => libc.symbols.waitpid(pid, status, 1)); }
    catch (error) { reapingFailure ??= error; }
  };
  capture();
  const timer = setInterval(capture, 20);
  try {
    const value = await operation();
    capture();
    if (reapingFailure) throw reapingFailure;
    return value;
  } finally { clearInterval(timer); libc.close(); }
}

function reapGroups(groups: ReadonlySet<number>, owned: Map<number, ProcessIdentity>, wait: (pid: number) => number): void {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const row = linuxProcess(Number(name));
    if (!row || !groups.has(row.group) || groups.has(row.pid)) continue;
    const previous = owned.get(row.pid);
    if (previous && previous.birth !== row.birth) throw new Error(`Consumer group PID ${row.pid} changed identity`);
    owned.set(row.pid, row);
    reapAdopted(row, wait);
  }
}
function reapAdopted(row: ProcessIdentity, wait: (pid: number) => number): void {
  if (row.parent !== process.pid || row.state !== "Z") return;
  const current = linuxProcess(row.pid);
  if (!current || current.birth !== row.birth || current.parent !== process.pid || current.state !== "Z") return;
  if (wait(row.pid) >= 0) return;
  const after = linuxProcess(row.pid);
  if (after?.birth === row.birth && after.parent === process.pid && after.state === "Z") throw new Error(`Cannot reap owned consumer descendant ${row.pid}`);
}

export function stopConsumerGroup(child: ChildProcess, graceMs = 5000): Promise<void> {
  return withConsumerGroups([child], () => stopProcessGroup(child, graceMs));
}
