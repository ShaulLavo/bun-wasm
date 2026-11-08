import { setTimeout } from "node:timers/promises";
import { ownedCommand } from "./lifetime";

export type SafariApplication = { pid: number; started: number };
export type DesktopSafari = { launchedAfter: number | null; observed: Map<number, SafariApplication> };
export interface SafariApplicationHost {
  applications(signal?: AbortSignal): Promise<SafariApplication[]>;
  open(uid: number, signal: AbortSignal): Promise<void>;
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
const host: SafariApplicationHost = {
  applications: async signal => parseSafariApplications(await ownedCommand(["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-axo", "pid=,lstart=,comm="], signal, 2000)),
  open: async (uid, signal) => { await ownedCommand(["/bin/launchctl", "asuser", String(uid), "/usr/bin/open", "-a", "Safari"], signal, 10_000); },
  wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
  now: Date.now,
  terminate: (pid, kind) => { try { process.kill(pid, kind); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } },
};
function capture(state: DesktopSafari, applications: readonly SafariApplication[]): SafariApplication[] {
  if (state.launchedAfter === null) return [];
  const launchedAfter = state.launchedAfter;
  if (state.observed.size) return remaining(state, applications);
  const candidates = applications.filter(application => application.started >= launchedAfter);
  for (const application of candidates) state.observed.set(application.pid, application);
  return candidates;
}
export async function prepareDesktopSafari(state: DesktopSafari, uid: number, signal: AbortSignal, io: SafariApplicationHost = host): Promise<void> {
  signal.throwIfAborted();
  if ((await io.applications(signal)).length) return;
  signal.throwIfAborted();
  state.launchedAfter = Math.floor(io.now() / 1000) * 1000;
  await io.open(uid, signal);
  capture(state, await io.applications(signal));
  // open returns before Safari has registered its automation target. Keep the
  // verified five-second GUI startup allowance separate from product deadlines.
  await io.wait(5000, signal);
  signal.throwIfAborted();
  if (!capture(state, await io.applications(signal)).length) throw new Error("Desktop Safari did not finish its bounded prelaunch");
}
function remaining(state: DesktopSafari, applications: readonly SafariApplication[]): SafariApplication[] {
  return applications.filter(application => state.observed.get(application.pid)?.started === application.started);
}
async function waitForExit(state: DesktopSafari, io: SafariApplicationHost): Promise<boolean> {
  const deadline = io.now() + 2000;
  while (true) {
    if (!remaining(state, await io.applications()).length) return true;
    if (io.now() >= deadline) return false;
    await io.wait(50);
  }
}
export async function stopDesktopSafari(state: DesktopSafari, io: SafariApplicationHost = host): Promise<void> {
  if (state.launchedAfter === null) return;
  // Also discover a launch that completed just before cancellation or open's error.
  capture(state, await io.applications());
  for (const kind of ["SIGTERM", "SIGKILL"] as const) {
    const applications = remaining(state, await io.applications());
    for (const application of applications) io.terminate(application.pid, kind);
    if (await waitForExit(state, io)) return;
  }
  throw new Error("Owned desktop Safari shutdown is unproved");
}
