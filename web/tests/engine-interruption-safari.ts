import { createServer } from "node:net";

export interface SafariDriverIdentity { pid: number; exitCode: number | null; signalCode: string | number | null; }
export interface SafariProcessIdentity { pid: number; ppid: number; session: string; started: number; }
export interface SafariDriverOwnership {
  driver: SafariDriverIdentity;
  spawnedAfter: number;
  root?: SafariProcessIdentity;
  verified: Map<number, SafariProcessIdentity>;
}
export interface SafariInspection {
  listeners(port: number, deadline?: number): Promise<number[]>;
  processes(deadline?: number): Promise<SafariProcessIdentity[]>;
}

export function ownSafariDriver(driver: SafariDriverIdentity, spawnedAfter: number): SafariDriverOwnership {
  // ps lstart has one-second precision. A child spawned in that second is valid.
  return { driver, spawnedAfter: Math.floor(spawnedAfter / 1_000) * 1_000, verified: new Map() };
}

// Reserve a private random port until the child is about to bind. Port allocation
// alone cannot close the release/bind race, so every WebDriver request also checks
// the listener's real process identity and the owned child's health.
export async function allocateSafariDriverPort(requested = 0): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: requested, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Safari driver port allocation failed");
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function assertAlive(driver: SafariDriverIdentity): void {
  if (driver.exitCode !== null || driver.signalCode !== null) throw new Error(`owned Safari driver ${driver.pid} exited (${driver.exitCode ?? driver.signalCode})`);
}

async function inspectCommand(args: string[], allowEmpty = false, deadline = Infinity): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Safari ownership inspection exceeded shutdown deadline");
  const command = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: Math.min(2_000, remaining), killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } });
  const stdout = new Response(command.stdout).text(), stderr = new Response(command.stderr).text();
  const status = await command.exited;
  const output = (await stdout).trim(), errors = (await stderr).trim();
  if (status !== 0 && !(allowEmpty && status === 1 && !output && !errors)) throw new Error(`Safari ownership inspection failed (${status}): ${errors}`);
  return output;
}

async function listenerPids(port: number, deadline?: number): Promise<number[]> {
  const output = await inspectCommand(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], true, deadline);
  if (!output) return [];
  const pids = output.split(/\s+/).map(Number);
  if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error("invalid Safari listener process identity");
  return Array.from(new Set(pids));
}

async function processIdentities(deadline?: number): Promise<SafariProcessIdentity[]> {
  return parseSafariProcessTable(await inspectCommand(["/bin/ps", "-axo", "pid=,ppid=,sess=,lstart="], false, deadline));
}

export function parseSafariProcessTable(output: string): SafariProcessIdentity[] {
  return output.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new Error(`invalid Safari process identity: ${line}`);
    const started = Date.parse(match[4]!);
    if (!Number.isFinite(started)) throw new Error(`invalid Safari process start time: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), session: match[3]!, started };
  });
}
const inspection: SafariInspection = { listeners: listenerPids, processes: processIdentities };

function sameProcess(left: SafariProcessIdentity, right: SafariProcessIdentity): boolean {
  return left.pid === right.pid && left.session === right.session && left.started === right.started;
}

function rememberTree(owned: SafariDriverOwnership, processes: readonly SafariProcessIdentity[]): Map<number, SafariProcessIdentity> {
  const root = processes.find(row => row.pid === owned.driver.pid);
  const tree = new Map<number, SafariProcessIdentity>();
  if (!root) return tree;
  if (root.started < owned.spawnedAfter || owned.root && !sameProcess(owned.root, root)) throw new Error("owned Safari driver process identity changed");
  owned.root ??= root;
  tree.set(root.pid, root);
  // Follow parents rather than accepting every member of the runner's session.
  // Safari normally forks its listener; siblings in that session are not ours.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of processes) {
      const parent = tree.get(row.ppid);
      if (!tree.has(row.pid) && parent && row.session === root.session && row.started >= owned.spawnedAfter && row.started >= parent.started) {
        tree.set(row.pid, row); changed = true;
      }
    }
  }
  for (const row of tree.values()) owned.verified.set(row.pid, row);
  return tree;
}

export async function assertSafariDriverOwnership(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection): Promise<void> {
  assertAlive(owned.driver);
  const pids = await inspect.listeners(port);
  const tree = rememberTree(owned, await inspect.processes());
  assertAlive(owned.driver);
  if (!pids.length || pids.some(pid => !tree.has(pid))) throw new Error(`Safari driver port ${port} not owned by task-created driver ${owned.driver.pid}: ${pids.join(",") || "no listener"}`);
}

// Keep birth/session identities after a child is reparented, but revalidate each
// one before signalling. Never kill a replacement PID or an unrelated listener.
export async function stopSafariDriver(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection, signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void = (pid, signal) => process.kill(pid, signal)): Promise<void> {
  // Reuse step9's session-first, bounded TERM -> KILL teardown policy. This
  // helper's inspections share a deadline below the runner's 15-second bound,
  // rather than racing a timeout that leaves cleanup running in the background.
  const shutdownDeadline = Date.now() + 12_000;
  let rows = await inspect.processes(shutdownDeadline);
  rememberTree(owned, rows);
  function remaining(): SafariProcessIdentity[] {
    return rows.filter(row => {
      const verified = owned.verified.get(row.pid);
      return verified !== undefined && sameProcess(verified, row);
    });
  }
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    const sent = new Map<number, SafariProcessIdentity>();
    const deadline = Math.min(Date.now() + 2_000, shutdownDeadline);
    do {
      // Discover children forked during shutdown while the original root can
      // still prove their ancestry. Previously verified orphans stay tracked.
      rememberTree(owned, rows);
      // Signal descendants before the parent; the parent may reap them on exit.
      for (const row of remaining().sort((left, right) => Number(left.pid === owned.driver.pid) - Number(right.pid === owned.driver.pid))) {
        const previous = sent.get(row.pid);
        if (previous && sameProcess(previous, row)) continue;
        try { signal(row.pid, kind); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
        sent.set(row.pid, row);
      }
      rows = await inspect.processes(shutdownDeadline);
      rememberTree(owned, rows);
      if (!remaining().length) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    if (!remaining().length) break;
  }
  const live = remaining();
  const listeners = await inspect.listeners(port, shutdownDeadline);
  if (live.length || listeners.length) throw new Error(`Safari driver shutdown unproved: processes=${live.map(row => row.pid).join(",") || "none"}; listeners=${listeners.join(",") || "none"}`);
}
