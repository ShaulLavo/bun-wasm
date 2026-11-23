import { setTimeout } from "node:timers/promises";
import { ownedCommand } from "./lifetime";

export type SafariApplication = { pid: number; started: number };
type SafariLaunch =
  | { kind: "none" }
  | { kind: "requested"; requested: number }
  | { kind: "reported"; requested: number; pid: number }
  | { kind: "owned"; requested: number; application: SafariApplication };
export type DesktopSafari = { launch: SafariLaunch };
export interface SafariApplicationHost {
  applications(signal?: AbortSignal): Promise<SafariApplication[]>;
  // Asks LaunchServices to launch Safari and returns the PID it reports for that launch.
  launch(uid: number, signal: AbortSignal): Promise<number>;
  terminate(pid: number, kind: "SIGTERM" | "SIGKILL"): void;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

export function parseSafariApplications(output: string): SafariApplication[] {
  const applications: SafariApplication[] = [];
  for (const line of output.split("\n")) {
    if (!line.trimEnd().endsWith("/Safari.app/Contents/MacOS/Safari")) continue;
    const match = /^\s*(\d+)\s+(.{24})\s+(.+)$/.exec(line);
    if (!match) throw new Error("Invalid desktop Safari process row");
    const pid = Number(match[1]), started = Date.parse(match[2]!);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(started)) throw new Error("Invalid desktop Safari process identity");
    applications.push({ pid, started });
  }
  return applications;
}

export function parseSafariLaunch(output: string): number {
  const pid: unknown = JSON.parse(output).pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) throw new Error("LaunchServices reported no Safari process");
  return pid;
}

// osascript program text, not a repository JavaScript source. NSWorkspace launches through
// LaunchServices, so a record LaunchServices still holds for an automatically terminated
// Safari is revived with this process. SafariDriver resolves its Safari through that record.
// The returned NSRunningApplication names the process LaunchServices started for this request.
const launchProgram = `ObjC.import("AppKit");
function run() {
  const app = $.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError($.NSURL.fileURLWithPath("/Applications/Safari.app"), 0, $.NSDictionary.dictionary, null);
  if (!app || app.isNil()) throw new Error("LaunchServices did not launch Safari");
  return JSON.stringify({ pid: app.processIdentifier });
}`;

const host: SafariApplicationHost = {
  applications: async signal => parseSafariApplications(await ownedCommand(["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-axo", "pid=,lstart=,comm="], signal, 2000)),
  launch: async (uid, signal) => parseSafariLaunch(await ownedCommand(["/bin/launchctl", "asuser", String(uid), "/usr/bin/osascript", "-l", "JavaScript", "-e", launchProgram], signal, 10_000)),
  terminate: (pid, kind) => { try { process.kill(pid, kind); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } },
  wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
  now: Date.now,
};

// ps lstart has one-second precision. A process started in the request's second is valid.
function startedAfter(application: SafariApplication, requested: number): boolean {
  return application.started >= Math.floor(requested / 1000) * 1000;
}

async function capture(state: DesktopSafari, io: SafariApplicationHost, signal?: AbortSignal): Promise<SafariApplication | undefined> {
  const launch = state.launch;
  if (launch.kind !== "reported" && launch.kind !== "owned") return undefined;
  const pid = launch.kind === "owned" ? launch.application.pid : launch.pid;
  const application = (await io.applications(signal)).find(application => application.pid === pid);
  if (!application) return undefined;
  if (launch.kind === "owned") return application.started === launch.application.started ? application : undefined;
  // LaunchServices names the process. An instance started before the request is not ours.
  if (!startedAfter(application, launch.requested)) return undefined;
  state.launch = { kind: "owned", requested: launch.requested, application };
  return application;
}

export async function prepareDesktopSafari(state: DesktopSafari, uid: number, signal: AbortSignal, io: SafariApplicationHost = host): Promise<void> {
  signal.throwIfAborted();
  if ((await io.applications(signal)).length) return;
  signal.throwIfAborted();
  const requested = io.now();
  state.launch = { kind: "requested", requested };
  state.launch = { kind: "reported", requested, pid: await io.launch(uid, signal) };
  await capture(state, io, signal);
  // LaunchServices returns before Safari registers its automation target. This setup
  // allowance does not change any product phase deadline.
  await io.wait(5000, signal);
  signal.throwIfAborted();
  const owned = await capture(state, io, signal);
  if (!owned) throw new Error("Desktop Safari did not finish its bounded prelaunch with proved ownership");
  if ((await io.applications(signal)).some(application => application.pid !== owned.pid)) throw new Error("Owner Safari raced desktop prelaunch; refusing driver startup");
}

async function lateLaunch(requested: number, io: SafariApplicationHost): Promise<boolean> {
  return (await io.applications()).some(application => startedAfter(application, requested));
}

// A launch whose PID was never attributed may still complete. Wait a finite time; any Safari
// started since the request keeps its application and the Mac lock rather than claiming success.
async function settleLaunch(state: DesktopSafari, io: SafariApplicationHost): Promise<SafariApplication | undefined> {
  const launch = state.launch;
  if (launch.kind === "none") return undefined;
  const deadline = io.now() + 2000;
  while (true) {
    const application = await capture(state, io);
    if (application) return application;
    if (state.launch.kind === "owned") return undefined;
    if (io.now() >= deadline) break;
    await io.wait(50);
  }
  if (await lateLaunch(launch.requested, io)) throw new Error("Desktop Safari launch ownership is unproved; preserving application and lock");
  return undefined;
}

async function exitedWithin(state: DesktopSafari, io: SafariApplicationHost): Promise<boolean> {
  const deadline = io.now() + 2000;
  while (await capture(state, io)) {
    if (io.now() >= deadline) return false;
    await io.wait(50);
  }
  return true;
}

export async function stopDesktopSafari(state: DesktopSafari, io: SafariApplicationHost = host): Promise<void> {
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    const application = await settleLaunch(state, io);
    if (!application) return;
    // Signal only the attributed PID after re-checking its captured start time.
    io.terminate(application.pid, kind);
    if (await exitedWithin(state, io)) return;
  }
  throw new Error("Owned desktop Safari shutdown is unproved");
}
