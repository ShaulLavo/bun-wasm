import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { ownedCommand } from "./lifetime";

export type SafariApplication = { pid: number; started: number };
type SafariLaunch = { kind: "none" } | { kind: "pending"; token: string } | { kind: "owned"; token: string; application: SafariApplication };
export type DesktopSafari = { launch: SafariLaunch };
export interface SafariApplicationHost {
  applications(signal?: AbortSignal): Promise<SafariApplication[]>;
  open(uid: number, token: string, signal: AbortSignal): Promise<void>;
  owns(application: SafariApplication, token: string, signal?: AbortSignal): Promise<boolean>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  terminate(pid: number, kind: "SIGTERM" | "SIGKILL"): void;
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
const marker = "BUN_WASM_GOALS_SAFARI_OWNER=";
const host: SafariApplicationHost = {
  applications: async signal => parseSafariApplications(await ownedCommand(["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-axo", "pid=,lstart=,comm="], signal, 2000)),
  open: async (uid, token, signal) => { await ownedCommand(["/bin/launchctl", "asuser", String(uid), "/usr/bin/open", "-a", "Safari", "--env", marker + token], signal, 10_000); },
  owns: async (application, token, signal) => {
    const output = await ownedCommand(["/bin/ps", "eww", "-p", String(application.pid), "-o", "command="], signal, 2000, false, [0, 1]);
    return output.split(/\s+/).includes(marker + token);
  },
  wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
  now: Date.now,
  terminate: (pid, kind) => { try { process.kill(pid, kind); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } },
};
async function capture(state: DesktopSafari, io: SafariApplicationHost, signal?: AbortSignal): Promise<SafariApplication | undefined> {
  const launch = state.launch;
  if (launch.kind === "none") return undefined;
  const applications = await io.applications(signal);
  for (const application of applications) {
    if (launch.kind === "owned" && (application.pid !== launch.application.pid || application.started !== launch.application.started)) continue;
    if (!await io.owns(application, launch.token, signal)) continue;
    state.launch = { kind: "owned", token: launch.token, application };
    return application;
  }
}
export async function prepareDesktopSafari(state: DesktopSafari, uid: number, signal: AbortSignal, io: SafariApplicationHost = host): Promise<void> {
  signal.throwIfAborted();
  if ((await io.applications(signal)).length) return;
  signal.throwIfAborted();
  const token = randomUUID();
  state.launch = { kind: "pending", token };
  await io.open(uid, token, signal);
  await capture(state, io, signal);
  // open returns before Safari registers its automation target. This verified
  // GUI allowance is setup time, not a change to any product phase deadline.
  await io.wait(5000, signal);
  signal.throwIfAborted();
  if (!await capture(state, io, signal)) throw new Error("Desktop Safari did not finish its bounded prelaunch with proved ownership");
}
async function settleLaunch(state: DesktopSafari, io: SafariApplicationHost): Promise<void> {
  const deadline = io.now() + 2000;
  while (!await capture(state, io)) {
    if (io.now() >= deadline) throw new Error("Desktop Safari launch ownership is unproved; preserving application and lock");
    await io.wait(50);
  }
}
async function waitForExit(state: DesktopSafari, io: SafariApplicationHost): Promise<boolean> {
  const deadline = io.now() + 2000;
  while (await capture(state, io)) {
    if (io.now() >= deadline) return false;
    await io.wait(50);
  }
  return true;
}
export async function stopDesktopSafari(state: DesktopSafari, io: SafariApplicationHost = host): Promise<void> {
  if (state.launch.kind === "none") return;
  // An asynchronous open can still complete after interruption. Empty process
  // snapshots do not prove its absence, and only our launch marker proves ownership.
  if (state.launch.kind === "pending") await settleLaunch(state, io);
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    const application = await capture(state, io);
    if (!application) return;
    io.terminate(application.pid, kind);
    if (await waitForExit(state, io)) return;
  }
  throw new Error("Owned desktop Safari shutdown is unproved");
}
