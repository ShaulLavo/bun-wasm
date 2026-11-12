import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Ownership of every process a supervisor starts, including descendants that
 * call setsid or are spawned detached. With child subreaping enabled (see
 * linux-subreaper.mts), such descendants reparent to the supervisor instead
 * of init, so they stay visible here. A process is identified by pid and
 * birth time together: a reused pid never authorizes a signal.
 */
export type ProcessIdentity = { pid: number; parent: number; group: number; session: number; birth: string; state: string };

export function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
export function linuxProcess(pid: number): ProcessIdentity | undefined {
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

export interface DrainTimes { readonly graceMs: number; readonly forceMs: number }

export class ProcessOwner {
  readonly owned = new Map<number, ProcessIdentity>();
  private roots: ProcessIdentity[] = [];

  /** Record a direct child as owned before it can fork. */
  adopt(pid: number): ProcessIdentity | undefined {
    const row = snapshot().find(candidate => candidate.pid === pid && candidate.parent === process.pid);
    if (row) this.roots.push(row);
    this.capture();
    return row;
  }

  /** Extend ownership to every live descendant of an owned process; returns the live owned set. */
  capture(): ProcessIdentity[] {
    const rows = snapshot();
    const current = new Map(rows.map(row => [row.pid, row]));
    const pending = rows.filter(row => this.owned.get(row.pid)?.birth === row.birth || process.platform === "linux" && row.parent === process.pid);
    for (const root of this.roots) if (current.get(root.pid)?.birth === root.birth) pending.push(root);
    const found = new Set<number>();
    while (pending.length > 0) {
      const row = pending.pop();
      if (!row || found.has(row.pid)) continue;
      found.add(row.pid);
      this.owned.set(row.pid, row);
      pending.push(...rows.filter(candidate => candidate.parent === row.pid));
    }
    return rows.filter(row => this.owned.get(row.pid)?.birth === row.birth && row.state !== "Z");
  }

  signal(signal: NodeJS.Signals): void {
    const current = process.platform === "linux" ? undefined : new Map(snapshot().map(row => [row.pid, row]));
    for (const row of this.owned.values()) {
      const now = process.platform === "linux" ? linuxProcess(row.pid) : current?.get(row.pid);
      if (!now || now.birth !== row.birth || now.state === "Z") continue;
      try { process.kill(row.pid, signal); }
      catch (error) { if (!isGone(error)) throw error; }
    }
  }

  /**
   * TERM every owned process, wait for the grace period, then KILL until the
   * deadline. Returns the processes still alive: empty means drain is proven.
   */
  async drain(times: DrainTimes): Promise<ProcessIdentity[]> {
    this.capture();
    this.signal("SIGTERM");
    const grace = performance.now() + times.graceMs;
    while (this.capture().length > 0 && performance.now() < grace) await delay(25);
    const forced = performance.now() + times.forceMs;
    while (this.capture().length > 0 && performance.now() < forced) {
      this.signal("SIGKILL");
      await delay(25);
    }
    return this.capture();
  }
}

export function describe(rows: readonly ProcessIdentity[]): string {
  return rows.map(row => `${row.pid}@${row.birth}`).join(", ");
}
