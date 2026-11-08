import { setTimeout } from "node:timers/promises";
import { ownedCommand } from "./lifetime";
import { bounded } from "./execute";

export type SafariApplication = { pid: number; started: number };
type SafariProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exitCode" | "signalCode" | "exited" | "kill">;
type SafariLaunch = { kind: "none" } | { kind: "spawned"; process: SafariProcess } | { kind: "owned"; process: SafariProcess; application: SafariApplication };
export type DesktopSafari = { launch: SafariLaunch };
export interface SafariApplicationHost {
  applications(signal?: AbortSignal): Promise<SafariApplication[]>;
  spawn(uid: number): SafariProcess;
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
const host: SafariApplicationHost = {
  applications: async signal => parseSafariApplications(await ownedCommand(["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-axo", "pid=,lstart=,comm="], signal, 2000)),
  spawn: uid => Bun.spawn(["/bin/launchctl", "asuser", String(uid), "/Applications/Safari.app/Contents/MacOS/Safari"], { stdout: "ignore", stderr: "inherit" }),
  wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
  now: Date.now,
};
function exited(child: SafariProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
async function capture(state: DesktopSafari, io: SafariApplicationHost, signal?: AbortSignal): Promise<SafariApplication | undefined> {
  const launch = state.launch;
  if (launch.kind === "none" || exited(launch.process)) return undefined;
  const applications = await io.applications(signal);
  const application = applications.find(application => application.pid === launch.process.pid);
  if (!application || exited(launch.process)) return undefined;
  if (launch.kind === "owned" && application.started !== launch.application.started) return undefined;
  state.launch = { kind: "owned", process: launch.process, application };
  return application;
}
export async function prepareDesktopSafari(state: DesktopSafari, uid: number, signal: AbortSignal, io: SafariApplicationHost = host): Promise<void> {
  signal.throwIfAborted();
  if ((await io.applications(signal)).length) return;
  signal.throwIfAborted();
  state.launch = { kind: "spawned", process: io.spawn(uid) };
  await capture(state, io, signal);
  // Direct launch retains a child handle while Safari registers its GUI target.
  // This setup allowance does not change any product phase deadline.
  await io.wait(5000, signal);
  signal.throwIfAborted();
  if (!await capture(state, io, signal)) throw new Error("Desktop Safari did not finish its bounded prelaunch with proved ownership");
  const pid = state.launch.process.pid;
  if ((await io.applications(signal)).some(application => application.pid !== pid)) throw new Error("Owner Safari raced desktop prelaunch; refusing driver startup");
}
async function settleLaunch(state: DesktopSafari, io: SafariApplicationHost): Promise<SafariApplication | undefined> {
  const deadline = io.now() + 2000;
  while (state.launch.kind !== "none") {
    const application = await capture(state, io);
    if (application) return application;
    const stopped = exited(state.launch.process);
    if (stopped && state.launch.kind !== "owned") throw new Error("Desktop Safari exited before ownership was proved; preserving application and lock");
    if (stopped) { await state.launch.process.exited; return undefined; }
    if (io.now() >= deadline) throw new Error("Desktop Safari launch ownership is unproved; preserving application and lock");
    await io.wait(50);
  }
}
export async function stopDesktopSafari(state: DesktopSafari, io: SafariApplicationHost = host): Promise<void> {
  if (state.launch.kind === "none") return;
  const child = state.launch.process;
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    const application = await settleLaunch(state, io);
    if (!application) return;
    // kill uses the retained child, never an unrelated PID found in a snapshot.
    child.kill(kind);
    if (await bounded(() => child.exited, 2000).then(() => true, () => false)) return;
  }
  throw new Error("Owned desktop Safari shutdown is unproved");
}
