import { setTimeout } from "node:timers/promises";
import { ownedCommand } from "./lifetime";
import { bounded } from "./bounded";

export type SafariApplication = { pid: number; started: number };
// `bornUs` is the kernel start time in integer microseconds since the epoch.
export type SafariBirth = { pid: number; bornUs: bigint };
// The helper's single report. `lost` means its output ended without one (crash or kill).
export type SafariReport =
  | { kind: "launched"; pid: number; requestedUs: bigint }
  | { kind: "not-launched" }
  | { kind: "existing" }
  | { kind: "lost" };
// A LaunchServices instance retained by a helper in the workload's process group.
export interface SafariInstance {
  report(): Promise<SafariReport>;
  // Marks the instance as this run's. After this, losing the controller terminates it.
  own(): void;
  // Force-terminates the retained instance. True once AppKit reports it terminated.
  terminate(): Promise<boolean>;
  // Ends the helper without touching an instance this run does not own.
  detach(): void;
  // Ends the helper after proved termination; it still waits for the process to be gone.
  release(): void;
  readonly exited: Promise<number>;
}
type SafariLaunch =
  | { kind: "none" }
  | { kind: "requested"; instance: SafariInstance }
  | { kind: "ended"; outcome: "existing" | "not-launched"; instance: SafariInstance }
  | { kind: "lost"; instance: SafariInstance }
  | { kind: "refused"; requestedUs: bigint; instance: SafariInstance; application: SafariBirth }
  | { kind: "owned"; requestedUs: bigint; instance: SafariInstance; application: SafariBirth };
export type DesktopSafari = { launch: SafariLaunch };
export interface SafariApplicationHost {
  applications(signal?: AbortSignal): Promise<SafariApplication[]>;
  birth(pid: number): Promise<bigint | undefined>;
  launch(uid: number): SafariInstance;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  // Finite waits for the helper's report and for a confirmed instance termination.
  limits?: { reportMs: number; terminateMs: number };
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

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`LaunchServices helper reported an invalid ${name}`);
  return value;
}

export function parseSafariReport(line: string | undefined): SafariReport {
  if (line === undefined) return { kind: "lost" };
  const report: unknown = JSON.parse(line);
  if (report === null || typeof report !== "object" || !("kind" in report)) throw new Error("Invalid LaunchServices helper report");
  if (report.kind === "not-launched" || report.kind === "existing") return { kind: report.kind };
  if (report.kind !== "launched") throw new Error("Invalid LaunchServices helper report");
  const pid = positive("pid" in report ? report.pid : undefined, "PID");
  const requestedUs = BigInt(positive("requestedUs" in report ? report.requestedUs : undefined, "request time"));
  return { kind: "launched", pid, requestedUs };
}

// osascript program text, not a repository JavaScript source. NSWorkspace launches through
// LaunchServices, which revives a record it still holds for an automatically terminated Safari;
// SafariDriver resolves its Safari through that record. Just before launching, the helper refuses
// if a live Safari already runs and records the request time in microseconds. It keeps the
// returned NSRunningApplication and force-terminates only that instance; forceTerminate sends no
// Apple Event, so no automation consent is involved. On closed input or `release` it waits until
// the instance is terminated and its process is gone. Only after `own` does closed input
// terminate the instance itself.
const helperProgram = `ObjC.import("AppKit");
ObjC.bindFunction("kill", ["int", ["int", "int"]]);
function out(value) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
function spin(seconds) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds)); }
function alive(pid) { return pid > 0 && $.kill(pid, 0) === 0; }
function settle(app, seconds) { for (let i = 0; i < seconds * 20 && !app.terminated; i++) spin(0.05); return app.terminated; }
function existing() {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Safari");
  for (let i = 0; i < apps.count; i++) { const app = apps.objectAtIndex(i); if (!app.terminated && alive(app.processIdentifier)) return true; }
  return false;
}
function run() {
  if (existing()) { out({ kind: "existing" }); return; }
  const requestedUs = Math.ceil($.NSDate.date.timeIntervalSince1970 * 1e6);
  const app = $.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError($.NSURL.fileURLWithPath("/Applications/Safari.app"), 0, $.NSDictionary.dictionary, null);
  if (!app || app.isNil()) { out({ kind: "not-launched" }); return; }
  const pid = app.processIdentifier;
  out({ kind: "launched", pid: pid, requestedUs: requestedUs });
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let owned = false;
  while (true) {
    const line = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input.availableData, $.NSUTF8StringEncoding));
    if (!line || line.indexOf("release") >= 0) break;
    if (line.indexOf("detach") >= 0) return;
    if (line.indexOf("own") >= 0) { owned = true; continue; }
    if (line.indexOf("terminate") >= 0 && !app.terminated) app.forceTerminate;
    out({ terminated: settle(app, 2) });
  }
  if (owned && !app.terminated) app.forceTerminate;
  while (!app.terminated || alive(pid)) spin(0.25);
}`;
// Ignored dispositions survive exec, so the queue's group SIGTERM or SIGINT on cancellation
// leaves the helper for the controller's cleanup; only the queue's later SIGKILL ends it.
const helperShell = 'trap "" TERM INT; exec /usr/bin/osascript -l JavaScript -e "$0"';

function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string | undefined> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffered += decoder.decode(value, { stream: true });
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    return line;
  };
}

export function helperInstance(command: string[]): SafariInstance {
  // Nothing here kills the helper: it holds the instance identity and keeps the queue's
  // process group occupied until its instance is gone.
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const next = lineReader(child.stdout);
  const reported = next().then(parseSafariReport);
  let open = true;
  const send = (command: string) => { if (!open) return; child.stdin.write(command + "\n"); void child.stdin.flush(); };
  const close = (command: string) => { send(command); if (!open) return; open = false; void child.stdin.end(); };
  return {
    report: () => reported,
    own: () => { send("own"); },
    terminate: async () => {
      if ((await reported).kind !== "launched") return false;
      send("terminate");
      const line = await next();
      return line !== undefined && JSON.parse(line).terminated === true;
    },
    detach: () => { close("detach"); },
    release: () => { close("release"); },
    exited: child.exited,
  };
}

// proc_bsdinfo (sys/proc_info.h): pid at offset 12, start seconds at 120, microseconds at 128.
type Libproc = { symbols: { proc_pidinfo(pid: number, flavor: number, arg: bigint, buffer: unknown, size: number): number } };
let libproc: Libproc | undefined;
async function processBirth(pid: number): Promise<bigint | undefined> {
  const { dlopen, ptr } = await import("bun:ffi");
  libproc ??= dlopen("/usr/lib/libproc.dylib", { proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" } });
  const buffer = new Uint8Array(136);
  if (libproc.symbols.proc_pidinfo(pid, 3, 0n, ptr(buffer), buffer.byteLength) !== buffer.byteLength) return undefined;
  const view = new DataView(buffer.buffer);
  if (view.getUint32(12, true) !== pid) return undefined;
  return view.getBigUint64(120, true) * 1_000_000n + view.getBigUint64(128, true);
}

const host: SafariApplicationHost = {
  applications: async signal => parseSafariApplications(await ownedCommand(["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-axo", "pid=,lstart=,comm="], signal, 2000)),
  birth: processBirth,
  launch: uid => helperInstance(["/bin/launchctl", "asuser", String(uid), "/bin/sh", "-c", helperShell, helperProgram]),
  wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
};

const limits = (io: SafariApplicationHost) => io.limits ?? { reportMs: 10_000, terminateMs: 5_000 };

// Ownership needs the PID LaunchServices reported to this request's helper and a kernel birth at
// or after the helper's own request time, both in integer microseconds.
async function attribute(state: DesktopSafari, io: SafariApplicationHost, signal?: AbortSignal): Promise<void> {
  const launch = state.launch;
  if (launch.kind !== "requested") return;
  const report = await bounded(() => launch.instance.report(), limits(io).reportMs, signal);
  const instance = launch.instance;
  if (report.kind === "lost") { state.launch = { kind: "lost", instance }; return; }
  if (report.kind !== "launched") { state.launch = { kind: "ended", outcome: report.kind, instance }; return; }
  const bornUs = await io.birth(report.pid);
  const application = { pid: report.pid, bornUs: bornUs ?? 0n };
  const owned = bornUs !== undefined && bornUs >= report.requestedUs;
  state.launch = { kind: owned ? "owned" : "refused", requestedUs: report.requestedUs, instance, application };
}

// attribute() replaces the launch record, so read it fresh rather than through a narrowed reference.
function current(state: DesktopSafari): SafariLaunch { return state.launch; }

function refusal(launch: SafariLaunch): Error | undefined {
  if (launch.kind === "ended" && launch.outcome === "existing") return new Error("Owner Safari raced desktop prelaunch; refusing driver startup");
  if (launch.kind === "ended") return new Error("LaunchServices did not launch desktop Safari");
  if (launch.kind === "lost") return new Error("Desktop Safari helper ended without a report");
  if (launch.kind === "refused") return new Error("LaunchServices returned a Safari this request did not start; refusing ownership");
  return undefined;
}

export async function prepareDesktopSafari(state: DesktopSafari, uid: number, signal: AbortSignal, io: SafariApplicationHost = host): Promise<void> {
  signal.throwIfAborted();
  if ((await io.applications(signal)).length) return;
  signal.throwIfAborted();
  state.launch = { kind: "requested", instance: io.launch(uid) };
  await attribute(state, io, signal);
  const launch = current(state);
  const refused = refusal(launch);
  if (refused) throw refused;
  if (launch.kind !== "owned") return;
  launch.instance.own();
  // LaunchServices returns before Safari registers its automation target. This setup
  // allowance does not change any product phase deadline.
  await io.wait(5000, signal);
  signal.throwIfAborted();
  if (await io.birth(launch.application.pid) !== launch.application.bornUs) throw new Error("Desktop Safari did not finish its bounded prelaunch with proved ownership");
  if ((await io.applications(signal)).some(application => application.pid !== launch.application.pid)) throw new Error("Owner Safari raced desktop prelaunch; refusing driver startup");
}

async function settleHelper(instance: SafariInstance, io: SafariApplicationHost): Promise<void> {
  await bounded(() => instance.exited, limits(io).terminateMs).catch(() => undefined);
}

// Unproved shutdown never releases the helper. It stays in the queue's process group until its
// instance is gone, or until the queue's own timeout kills the group.
export async function stopDesktopSafari(state: DesktopSafari, io: SafariApplicationHost = host): Promise<void> {
  if (state.launch.kind === "none") return;
  // A request still awaiting its report gets a finite chance to name its instance.
  await attribute(state, io).catch(() => undefined);
  const launch = current(state);
  if (launch.kind === "none") return;
  if (launch.kind === "requested") throw new Error("Desktop Safari launch ownership is unproved; its helper stays with the instance");
  if (launch.kind === "lost") throw new Error("Desktop Safari helper ended without a report; ownership is unproved");
  if (launch.kind === "ended") return settleHelper(launch.instance, io);
  if (launch.kind === "refused") { launch.instance.detach(); return settleHelper(launch.instance, io); }
  // Termination goes through the retained instance, never a raw signal to a PID.
  const terminated = await bounded(() => launch.instance.terminate(), limits(io).terminateMs).catch(() => false);
  const gone = await io.birth(launch.application.pid) !== launch.application.bornUs;
  if (!terminated || !gone) throw new Error("Owned desktop Safari shutdown is unproved");
  launch.instance.release();
  await settleHelper(launch.instance, io);
}
