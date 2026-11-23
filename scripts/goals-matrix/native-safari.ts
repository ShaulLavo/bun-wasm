import { setTimeout } from "node:timers/promises";
import { ownedCommand } from "./lifetime";
import { bounded } from "./bounded";

export type SafariApplication = { pid: number; started: number };
// `born` is the kernel start time in milliseconds with microsecond precision.
export type SafariBirth = { pid: number; born: number };
// A LaunchServices instance retained by a helper in the workload's process group.
export interface SafariInstance {
  // The PID LaunchServices reported for this request, or undefined when it launched nothing.
  report(): Promise<number | undefined>;
  // Force-terminates the retained instance. True once that instance has terminated.
  terminate(): Promise<boolean>;
  // Ends the helper without touching an instance this run does not own.
  detach(): void;
  // Closes the helper's input. The helper exits once its instance has terminated.
  release(): void;
  readonly exited: Promise<number>;
}
type SafariLaunch =
  | { kind: "none" }
  | { kind: "requested"; requested: number; instance: SafariInstance }
  | { kind: "refused"; requested: number; instance: SafariInstance; application: SafariBirth }
  | { kind: "owned"; requested: number; instance: SafariInstance; application: SafariBirth };
export type DesktopSafari = { launch: SafariLaunch };
export interface SafariApplicationHost {
  applications(signal?: AbortSignal): Promise<SafariApplication[]>;
  birth(pid: number): Promise<number | undefined>;
  launch(uid: number): SafariInstance;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
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

export function parseSafariReport(line: string | undefined): number | undefined {
  if (line === undefined) return undefined;
  const report: unknown = JSON.parse(line);
  if (report === null || typeof report !== "object") throw new Error("Invalid LaunchServices helper report");
  if ("error" in report) return undefined;
  const pid = "pid" in report ? report.pid : undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) throw new Error("LaunchServices reported no Safari process");
  return pid;
}

// osascript program text, not a repository JavaScript source. NSWorkspace launches through
// LaunchServices, which revives a record it still holds for an automatically terminated Safari;
// SafariDriver resolves its Safari through that record. The helper keeps the returned
// NSRunningApplication and force-terminates only that instance. forceTerminate sends no Apple
// Event, so no automation consent is involved. On closed input it stays until the instance ends.
const helperProgram = `ObjC.import("AppKit");
function out(value) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
function spin(seconds) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds)); }
function settle(app, seconds) { for (let i = 0; i < seconds * 20 && !app.terminated; i++) spin(0.05); return app.terminated; }
function run() {
  const app = $.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError($.NSURL.fileURLWithPath("/Applications/Safari.app"), 0, $.NSDictionary.dictionary, null);
  if (!app || app.isNil()) { out({ error: "LaunchServices did not launch Safari" }); return; }
  out({ pid: app.processIdentifier });
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  while (true) {
    const line = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input.availableData, $.NSUTF8StringEncoding));
    if (!line) break;
    if (line.indexOf("detach") >= 0) return;
    if (line.indexOf("terminate") >= 0 && !app.terminated) app.forceTerminate;
    out({ terminated: settle(app, 2) });
  }
  while (!app.terminated) spin(0.5);
}`;

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
  // process group occupied. It ends on detach, or after its instance has terminated.
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const next = lineReader(child.stdout);
  const reported = next().then(parseSafariReport);
  let open = true;
  const send = (command: string) => { if (!open) return; child.stdin.write(command + "\n"); void child.stdin.flush(); };
  const close = () => { if (!open) return; open = false; void child.stdin.end(); };
  return {
    report: () => reported,
    terminate: async () => {
      if (await reported === undefined) return false;
      send("terminate");
      const line = await next();
      return line !== undefined && JSON.parse(line).terminated === true;
    },
    detach: () => { send("detach"); close(); },
    release: close,
    exited: child.exited,
  };
}

// proc_bsdinfo (sys/proc_info.h): pid at offset 12, start seconds at 120, microseconds at 128.
type Libproc = { symbols: { proc_pidinfo(pid: number, flavor: number, arg: bigint, buffer: unknown, size: number): number } };
let libproc: Libproc | undefined;
async function processBirth(pid: number): Promise<number | undefined> {
  const { dlopen, ptr } = await import("bun:ffi");
  libproc ??= dlopen("/usr/lib/libproc.dylib", { proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" } });
  const buffer = new Uint8Array(136);
  if (libproc.symbols.proc_pidinfo(pid, 3, 0n, ptr(buffer), buffer.byteLength) !== buffer.byteLength) return undefined;
  const view = new DataView(buffer.buffer);
  if (view.getUint32(12, true) !== pid) return undefined;
  return Number(view.getBigUint64(120, true)) * 1000 + Number(view.getBigUint64(128, true)) / 1000;
}

const host: SafariApplicationHost = {
  applications: async signal => parseSafariApplications(await ownedCommand(["/usr/bin/env", "LC_ALL=C", "/bin/ps", "-axo", "pid=,lstart=,comm="], signal, 2000)),
  birth: processBirth,
  launch: uid => helperInstance(["/bin/launchctl", "asuser", String(uid), "/usr/bin/osascript", "-l", "JavaScript", "-e", helperProgram]),
  wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
  now: Date.now,
};

const limits = (io: SafariApplicationHost) => io.limits ?? { reportMs: 10_000, terminateMs: 5_000 };

// Ownership needs the PID LaunchServices reported to this request's helper and a kernel birth
// after the request. An instance LaunchServices returns that already ran is refused.
async function attribute(state: DesktopSafari, io: SafariApplicationHost, signal?: AbortSignal): Promise<void> {
  const launch = state.launch;
  if (launch.kind !== "requested") return;
  const pid = await bounded(() => launch.instance.report(), limits(io).reportMs, signal);
  if (pid === undefined) return;
  const born = await io.birth(pid);
  const application = { pid, born: born ?? 0 };
  const owned = born !== undefined && born >= launch.requested;
  state.launch = { kind: owned ? "owned" : "refused", requested: launch.requested, instance: launch.instance, application };
}

// attribute() replaces the launch record, so read it fresh rather than through a narrowed reference.
function current(state: DesktopSafari): SafariLaunch { return state.launch; }

export async function prepareDesktopSafari(state: DesktopSafari, uid: number, signal: AbortSignal, io: SafariApplicationHost = host): Promise<void> {
  signal.throwIfAborted();
  if ((await io.applications(signal)).length) return;
  signal.throwIfAborted();
  const requested = io.now();
  state.launch = { kind: "requested", requested, instance: io.launch(uid) };
  await attribute(state, io, signal);
  const launch = current(state);
  if (launch.kind === "none") return;
  if (launch.kind === "requested") throw new Error("LaunchServices did not launch desktop Safari");
  if (launch.kind === "refused") throw new Error("LaunchServices returned a Safari this request did not start; refusing ownership");
  // LaunchServices returns before Safari registers its automation target. This setup
  // allowance does not change any product phase deadline.
  await io.wait(5000, signal);
  signal.throwIfAborted();
  if (await io.birth(launch.application.pid) !== launch.application.born) throw new Error("Desktop Safari did not finish its bounded prelaunch with proved ownership");
  if ((await io.applications(signal)).some(application => application.pid !== launch.application.pid)) throw new Error("Owner Safari raced desktop prelaunch; refusing driver startup");
}

async function settleHelper(instance: SafariInstance, io: SafariApplicationHost): Promise<void> {
  await bounded(() => instance.exited, limits(io).terminateMs).catch(() => undefined);
}

// Unproved shutdown leaves the helper waiting on its live instance, so the queue's process
// group stays occupied until Safari ends or the queue's own workload timeout stops the group.
export async function stopDesktopSafari(state: DesktopSafari, io: SafariApplicationHost = host): Promise<void> {
  if (state.launch.kind === "none") return;
  // A request still awaiting its report gets a finite chance to name its instance.
  const reported = await attribute(state, io).then(() => true, () => false);
  const launch = current(state);
  if (launch.kind === "none") return;
  if (launch.kind === "requested") {
    // The helper reported that LaunchServices launched nothing; it has already ended.
    if (reported) return settleHelper(launch.instance, io);
    throw new Error("Desktop Safari launch ownership is unproved; its helper stays with the instance");
  }
  if (launch.kind === "refused") { launch.instance.detach(); await settleHelper(launch.instance, io); return; }
  // Termination goes through the retained instance, never a raw signal to a PID.
  const terminated = await bounded(() => launch.instance.terminate(), limits(io).terminateMs).catch(() => false);
  const gone = await io.birth(launch.application.pid) !== launch.application.born;
  launch.instance.release();
  if (!terminated || !gone) throw new Error("Owned desktop Safari shutdown is unproved");
  await settleHelper(launch.instance, io);
}
