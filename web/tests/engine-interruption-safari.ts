import { createServer } from "node:net";

export interface SafariDriverIdentity { pid: number; exitCode: number | null; signalCode: string | number | null; }
export interface SafariProcessIdentity { pid: number; ppid: number; group: number; started: number; }
export interface SafariDriverOwnership {
  driver: SafariDriverIdentity;
  spawnedAfter: number;
  root?: SafariProcessIdentity;
  allocatedPort?: number;
  associated?: SafariProcessIdentity;
  confirmed: boolean;
  observed: Map<number, SafariProcessIdentity>;
  verified: Map<number, SafariProcessIdentity>;
}
export interface SafariInspection {
  listeners(port: number, deadline?: number): Promise<number[]>;
  processes(deadline?: number): Promise<SafariProcessIdentity[]>;
  executable?(pid: number, deadline?: number): Promise<string | undefined>;
}

export function ownSafariDriver(driver: SafariDriverIdentity, spawnedAfter: number, allocatedPort?: number): SafariDriverOwnership {
  // ps lstart has one-second precision. A child spawned in that second is valid.
  return { driver, spawnedAfter: Math.floor(spawnedAfter / 1_000) * 1_000, allocatedPort, confirmed: false, observed: new Map(), verified: new Map() };
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
  const output = await inspectCommand([process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], true, deadline);
  if (!output) return [];
  const pids = output.split(/\s+/).map(Number);
  if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error("invalid Safari listener process identity");
  return Array.from(new Set(pids));
}

async function processIdentities(deadline?: number): Promise<SafariProcessIdentity[]> {
  return parseSafariProcessTable(await inspectCommand(["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart="], false, deadline));
}

export function parseSafariProcessTable(output: string): SafariProcessIdentity[] {
  return output.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error(`invalid Safari process identity: ${line}`);
    const started = Date.parse(match[4]!);
    if (!Number.isFinite(started)) throw new Error(`invalid Safari process start time: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), started };
  });
}
const appleHttpService = "/System/Library/PrivateFrameworks/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService";

async function executablePath(pid: number, deadline = Infinity): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  if (Date.now() >= deadline) throw new Error("Safari executable inspection exceeded shutdown deadline");
  // ps comm/command comes from argv[0], not the kernel's executable path.
  // Public libproc gives the latter; no private responsibility APIs or grants.
  const { dlopen, ptr } = await import("bun:ffi");
  if (Date.now() >= deadline) throw new Error("Safari executable inspection exceeded shutdown deadline");
  const library = dlopen("/usr/lib/libproc.dylib", { proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" } });
  try {
    const buffer = new Uint8Array(4_096);
    const count = library.symbols.proc_pidpath(pid, ptr(buffer), buffer.byteLength);
    if (Date.now() >= deadline) throw new Error("Safari executable inspection exceeded shutdown deadline");
    if (count <= 0) return undefined;
    const end = buffer.indexOf(0);
    return new TextDecoder().decode(end < 0 ? buffer : buffer.subarray(0, end));
  } finally { library.close(); }
}

const inspection: SafariInspection = { listeners: listenerPids, processes: processIdentities, executable: executablePath };

function sameProcess(left: SafariProcessIdentity, right: SafariProcessIdentity): boolean {
  return left.pid === right.pid && left.group === right.group && left.started === right.started;
}

function rememberTree(owned: SafariDriverOwnership, processes: readonly SafariProcessIdentity[]): Map<number, SafariProcessIdentity> {
  const root = processes.find(row => row.pid === owned.driver.pid);
  const tree = new Map<number, SafariProcessIdentity>();
  if (!root) return tree;
  if (root.started < owned.spawnedAfter || owned.root && !sameProcess(owned.root, root)) throw new Error("owned Safari driver process identity changed");
  owned.root ??= root;
  tree.set(root.pid, root);
  // Follow parents, not merely matching process groups. Unlike Darwin's redacted
  // ps sess pointer, pgid identifies a real group; siblings are still not ours.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of processes) {
      const parent = tree.get(row.ppid);
      if (!tree.has(row.pid) && parent && row.group === root.group && row.started >= owned.spawnedAfter && row.started >= parent.started) {
        tree.set(row.pid, row); changed = true;
      }
    }
  }
  for (const row of tree.values()) owned.verified.set(row.pid, row);
  return tree;
}

export async function assertSafariDriverOwnership(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection, deadline?: number): Promise<void> {
  assertAlive(owned.driver);
  const pids = await inspect.listeners(port, deadline);
  const rows = await inspect.processes(deadline);
  const tree = rememberTree(owned, rows);
  let accepted = pids.length > 0 && pids.every(pid => tree.has(pid));
  const root = tree.get(owned.driver.pid);
  if (!accepted && pids.length === 1 && owned.allocatedPort === port && root) {
    const candidate = rows.find(row => row.pid === pids[0]);
    // Real Safari launches HTTPService through launchd (PPID 1, separate group),
    // not as our child. Only associate this exact system executable on the free
    // port we allocated and passed to our live driver; never claim its ownership.
    if (candidate && candidate.ppid === 1 && candidate.started >= owned.spawnedAfter && candidate.started >= root.started
      && (!owned.associated || sameProcess(owned.associated, candidate))) {
      // A failed asynchronous inspection must not erase a possible consumer.
      // Observed candidates are never owned or signalled; only watched at exit.
      if (!owned.associated) owned.observed.set(candidate.pid, candidate);
      if (await inspect.executable?.(candidate.pid, deadline) === appleHttpService) {
        const confirmedRows = await inspect.processes(deadline);
        const confirmedTree = rememberTree(owned, confirmedRows);
        const confirmed = confirmedRows.find(row => row.pid === candidate.pid);
        const confirmedListeners = await inspect.listeners(port, deadline);
        if (confirmedTree.has(owned.driver.pid) && confirmed?.ppid === 1 && sameProcess(candidate, confirmed)
          && confirmedListeners.length === 1 && confirmedListeners[0] === candidate.pid) {
          owned.associated = confirmed;
          owned.observed.delete(candidate.pid);
          accepted = true;
        }
      }
    }
  }
  assertAlive(owned.driver);
  if (!accepted) throw new Error(`Safari driver port ${port} not owned or associated with task-created driver ${owned.driver.pid}: ${pids.join(",") || "no listener"}`);
  owned.confirmed = true;
}

// Keep birth/group identities after a child is reparented, but revalidate each
// one before signalling. Never kill a replacement PID or an unrelated listener.
export async function stopSafariDriver(owned: SafariDriverOwnership, port: number,
  inspect: SafariInspection = inspection, signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void = (pid, signal) => process.kill(pid, signal)): Promise<void> {
  // Reuse step9's session-first, bounded TERM -> KILL teardown policy. This
  // helper's inspections share a deadline below the runner's 15-second bound,
  // rather than racing a timeout that leaves cleanup running in the background.
  const shutdownDeadline = Date.now() + 12_000;
  let rows = await inspect.processes(shutdownDeadline);
  rememberTree(owned, rows);
  let associationError: string | undefined;
  if (owned.allocatedPort === port && !owned.associated) {
    // Startup may fail before a successful request commits its association.
    // Discover it before stopping the driver; failure must not skip stopping
    // owned processes, nor turn an untracked XPC with a closed port into green.
    // Reserve six seconds for fresh identities, TERM/KILL and final checks.
    const discoveryDeadline = Math.min(Date.now() + 3_000, shutdownDeadline - 6_000);
    try {
      if ((await inspect.listeners(port, discoveryDeadline)).length) await assertSafariDriverOwnership(owned, port, inspect, discoveryDeadline);
      else if (!owned.confirmed) associationError = "startup listener never confirmed; XPC shutdown is unproved";
    } catch (error) { associationError = String(error); }
    rows = await inspect.processes(shutdownDeadline);
    rememberTree(owned, rows);
  }
  function remaining(): SafariProcessIdentity[] {
    return rows.filter(row => {
      const verified = owned.verified.get(row.pid);
      const associated = owned.associated, observed = owned.observed.get(row.pid);
      return !(associated && sameProcess(associated, row)) && !(observed && sameProcess(observed, row))
        && verified !== undefined && sameProcess(verified, row);
    });
  }
  function associatedRemaining(): SafariProcessIdentity[] {
    const associated = owned.associated;
    return associated ? rows.filter(row => sameProcess(associated, row)) : [];
  }
  function observedRemaining(): SafariProcessIdentity[] {
    return rows.filter(row => {
      const observed = owned.observed.get(row.pid);
      return observed !== undefined && sameProcess(observed, row);
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
      if (!remaining().length && !associatedRemaining().length && !observedRemaining().length) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    if (!remaining().length && !associatedRemaining().length && !observedRemaining().length) break;
  }
  const live = remaining(), associated = associatedRemaining(), observed = observedRemaining();
  const listeners = await inspect.listeners(port, shutdownDeadline);
  if (associationError || live.length || associated.length || observed.length || listeners.length) throw new Error(`Safari driver shutdown unproved: processes=${live.map(row => row.pid).join(",") || "none"}; associated=${associated.map(row => row.pid).join(",") || "none"}; observed=${observed.map(row => row.pid).join(",") || "none"}; listeners=${listeners.join(",") || "none"}${associationError ? `; association inspection=${associationError}` : ""}`);
}
