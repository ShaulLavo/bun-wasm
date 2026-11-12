// macOS native access for the opt-in Safari causal capture: CPU time and kernel start time of
// given PIDs, a task-owned launchd control job, and an exact-target launchd log query.
// See docs/bun-patches/goals-safari-causal-capture.md for the rusage layout source.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedCommand } from "./lifetime";
import { clock, type Clock } from "./safari-protocol";

export type ProcessClock = Readonly<{ cpuMs: number; birth: string }>;
export type NativeService = "webcontent" | "control";
export type NativeEvent = Readonly<{
  kind: "signal-service" | "exit"; eventTime: string; eventUtc: string | null; reporter: "launchd"; reporterPid: number;
  target: number; service: NativeService; parentPid: number | null; signal: number | null; exitCode: number | null;
  caller: Readonly<{ name: string; pid: number }> | null; received: Clock;
}>;
export type NativeQuery = Readonly<{ events: readonly NativeEvent[]; ignored: number }>;
export type ControlReceipt = {
  passed: boolean; failure: string | null; label: string; pid: number | null; readErrno: number | null; cpuRatio: number | null; birthStable: boolean;
  exitObserved: boolean; killerPid: number | null; event: NativeEvent | null; classes: NativeEvent["kind"][];
  jobRemoved: boolean; fileRemoved: boolean; startedAt: string; finishedAt: string | null;
};
export interface NativePort {
  read(pid: number): ProcessClock | null;
  candidates(): Promise<number[]>;
  control(directory: string): Promise<ControlReceipt>;
  query(pid: number, service: NativeService, start: Date, end: Date): Promise<NativeQuery>;
}

type Libproc = { rusage: (pid: number, flavor: number, buffer: ReturnType<typeof ptr>) => number; errno: () => number; numer: bigint; denom: bigint };
let libproc: Libproc | undefined;
function loadLibproc(): Libproc {
  if (process.platform !== "darwin") throw new Error("Safari causal capture native access requires macOS");
  const proc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
  const system = dlopen("/usr/lib/libSystem.B.dylib", { mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 }, __error: { args: [], returns: FFIType.ptr } });
  const timebase = new Uint32Array(2);
  if (system.symbols.mach_timebase_info(ptr(timebase)) !== 0 || !timebase[0] || !timebase[1]) throw new Error("mach_timebase_info failed");
  const errno = () => {
    const location = system.symbols.__error();
    return location ? read.i32(location, 0) : -1;
  };
  return { rusage: proc.symbols.proc_pid_rusage, errno, numer: BigInt(timebase[0]), denom: BigInt(timebase[1]) };
}
// errno of the last failed read, or 0 when the kernel returned a zero start time.
let lastReadErrno: number | null = null;
// rusage_info_v4 is 296 bytes; the buffer is larger. Offsets: user time 16, system time 24 (Mach ticks),
// proc_start_abstime 80. Only these three fields are read.
const usage = new BigUint64Array(48);
function readProcess(pid: number): ProcessClock | null {
  const lib = libproc ??= loadLibproc();
  usage.fill(0n);
  lastReadErrno = null;
  if (lib.rusage(pid, 4, ptr(usage)) !== 0) { lastReadErrno = lib.errno(); return null; }
  const birth = usage[10] ?? 0n;
  if (birth === 0n) { lastReadErrno = 0; return null; }
  const nanoseconds = ((usage[2] ?? 0n) + (usage[3] ?? 0n)) * lib.numer / lib.denom;
  return { cpuMs: Number(nanoseconds) / 1e6, birth: String(birth) };
}

/** Desktop WebContent PIDs by executable name only. Simulator runtimes are excluded. */
async function webContentCandidates(): Promise<number[]> {
  const table = await ownedCommand(["/bin/ps", "-axo", "pid=,comm="], undefined, 10_000);
  return table.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match?.[2] || !match[2].endsWith("/com.apple.WebKit.WebContent") || match[2].includes("CoreSimulator")) return [];
    return [Number(match[1])];
  });
}

function logTime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Only launchd records whose subject is exactly this PID. The parser validates the token again. */
export function launchdPredicate(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid target PID");
  return `process == "launchd" AND (subsystem ENDSWITH " [${pid}]" OR eventMessage CONTAINS "[${pid}]:]")`;
}

const signals: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 10, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 };
type Subject = { service: string; pid: number; message: string };
type Classified = Pick<NativeEvent, "kind" | "signal" | "exitCode" | "caller">;
type Entry = { timestamp: string; processID: number; processImagePath: string; eventMessage: string; subsystem: string };

function entries(text: string): Entry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const values: unknown[] = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split("\n").map(line => JSON.parse(line));
  return values.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const { timestamp, processID, processImagePath, eventMessage, subsystem } = value as Record<string, unknown>;
    if (typeof timestamp !== "string" || typeof processID !== "number" || typeof processImagePath !== "string" || typeof eventMessage !== "string") return [];
    return [{ timestamp, processID, processImagePath, eventMessage, subsystem: typeof subsystem === "string" ? subsystem : "" }];
  });
}

function subject(entry: Entry): Subject | undefined {
  const fromSubsystem = /^(\S+) \[(\d+)\]$/.exec(entry.subsystem);
  if (fromSubsystem?.[1] && fromSubsystem[2]) return { service: fromSubsystem[1], pid: Number(fromSubsystem[2]), message: entry.eventMessage };
  const fromMessage = /^\[(\S+) \[(\d+)\]:\] (.*)$/s.exec(entry.eventMessage);
  if (fromMessage?.[1] && fromMessage[2] && fromMessage[3] !== undefined) return { service: fromMessage[1], pid: Number(fromMessage[2]), message: fromMessage[3] };
}

const callerName = "([A-Za-z0-9_.-][A-Za-z0-9_. -]{0,63})";
function classify(message: string): Classified | undefined {
  const service = new RegExp(`^signal service: caller = ${callerName}\\[(\\d+)\\], value = 0x([0-9a-fA-F]{1,2})$`).exec(message);
  if (service?.[1] && service[2] && service[3]) return { kind: "signal-service", signal: parseInt(service[3], 16), exitCode: null, caller: { name: service[1], pid: Number(service[2]) } };
  const signalled = new RegExp(`^exited due to (SIG[A-Z0-9]+)(?: \\| sent by ${callerName}\\[(\\d+)\\])?`).exec(message);
  if (signalled?.[1]) return { kind: "exit", signal: signals[signalled[1]] ?? null, exitCode: null, caller: signalled[2] && signalled[3] ? { name: signalled[2], pid: Number(signalled[3]) } : null };
  const code = /^exited with exit code: (\d+)/.exec(message);
  if (code?.[1]) return { kind: "exit", signal: null, exitCode: Number(code[1]), caller: null };
}

function eventUtc(timestamp: string): string | null {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(\d\d)$/.exec(timestamp);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}${(match[3] ?? "").slice(0, 4)}${match[4]}:${match[5]}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Accepts the exact target only; everything else is counted and discarded without retaining text. */
export function normalizeLaunchdLog(text: string, pid: number, accept: (service: string) => NativeService | undefined, received = clock()): NativeQuery {
  const events: NativeEvent[] = [];
  let ignored = 0;
  for (const entry of entries(text)) {
    const found = entry.processID === 1 && entry.processImagePath === "/sbin/launchd" ? subject(entry) : undefined;
    const service = found && found.pid === pid ? accept(found.service) : undefined;
    const classified = found && service ? classify(found.message) : undefined;
    if (!found || !service || !classified) { ignored++; continue; }
    const parent = /^pid\/(\d+)\//.exec(found.service)?.[1];
    events.push({ ...classified, eventTime: entry.timestamp, eventUtc: eventUtc(entry.timestamp), reporter: "launchd", reporterPid: 1,
      target: pid, service, parentPid: parent ? Number(parent) : null, received });
  }
  return { events, ignored };
}

export const webContentService = (service: string): NativeService | undefined => /^pid\/\d+\/com\.apple\.WebKit\.WebContent(?:\.[0-9A-F-]+)?$/.test(service) ? "webcontent" : undefined;

async function queryLaunchd(pid: number, start: Date, end: Date, accept: (service: string) => NativeService | undefined): Promise<NativeQuery> {
  const text = await ownedCommand(["/usr/bin/log", "show", "--style", "json", "--info", "--start", logTime(start), "--end", logTime(end), "--predicate", launchdPredicate(pid)], undefined, 60_000);
  return normalizeLaunchdLog(text, pid, accept);
}

function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function controlPlist(label: string, executable: string): string {
  // A bounded CPU-only loop: it exits by itself after 20 s and is never restarted.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>-e</string><string>const end = Date.now() + 20000; while (end &gt; Date.now()) {}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>
`;
}

function exitCode(args: string[]): Promise<number> {
  return Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exited;
}

async function jobPid(target: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = await ownedCommand(["/bin/launchctl", "print", target], undefined, 5000).catch(() => "");
    // launchd reports the PID while xpcproxy is still preparing the exec; wait for the program itself.
    const pid = Number(/^\s*pid = (\d+)$/m.exec(text)?.[1]);
    if (/^\s*state = running$/m.test(text) && Number.isSafeInteger(pid) && pid > 1) return pid;
    await Bun.sleep(100);
  }
  throw new Error("control job did not report a PID");
}

async function waitForExit(pid: number, birth: string): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (readProcess(pid)?.birth !== birth) return true;
    await Bun.sleep(50);
  }
  return false;
}

// Bounded wait for the exec to settle. Failures keep their errno in the receipt.
async function firstReading(pid: number): Promise<ProcessClock | null> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const reading = readProcess(pid);
    if (reading || Date.now() >= deadline) return reading;
    await Bun.sleep(50);
  }
}

/** Exercise the reader, the kill path and the log parser on a uniquely labelled job this task owns. */
async function exerciseControl(receipt: ControlReceipt, target: string): Promise<void> {
  const pid = receipt.pid = await jobPid(target);
  const first = await firstReading(pid);
  receipt.readErrno = lastReadErrno;
  if (!first) throw new Error(`control process unreadable at first read (errno ${String(lastReadErrno)})`);
  const started = performance.now();
  await Bun.sleep(600);
  const second = readProcess(pid);
  const wall = performance.now() - started;
  receipt.readErrno = lastReadErrno;
  if (!second) throw new Error(`control process unreadable at second read (errno ${String(lastReadErrno)})`);
  receipt.birthStable = first.birth === second.birth;
  receipt.cpuRatio = Math.round((second.cpuMs - first.cpuMs) / wall * 100) / 100;
  if (!receipt.birthStable || receipt.cpuRatio < 0.3 || receipt.cpuRatio > 1.5) throw new Error("control CPU or start-time reading is implausible");
  const killer = Bun.spawn(["/bin/launchctl", "kill", "SIGKILL", target], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  receipt.killerPid = killer.pid;
  if (await killer.exited !== 0) throw new Error("launchctl kill failed for the control job");
  receipt.exitObserved = await waitForExit(pid, first.birth);
  if (!receipt.exitObserved) throw new Error("control process exit not observed");
}

async function removeControl(receipt: ControlReceipt, target: string, plist: string): Promise<void> {
  await exitCode(["/bin/launchctl", "bootout", target]);
  receipt.jobRemoved = await exitCode(["/bin/launchctl", "print", target]) !== 0;
  await rm(plist, { force: true });
  receipt.fileRemoved = !await Bun.file(plist).exists();
}

function provingEvent(query: NativeQuery, receipt: ControlReceipt): NativeEvent | undefined {
  return query.events.find(event => event.signal === 9 && event.caller?.name === "launchctl" && event.caller.pid === receipt.killerPid);
}

async function launchdControl(directory: string): Promise<ControlReceipt> {
  const uid = process.getuid?.();
  const label = `dev.bun-wasm.causal-control.${crypto.randomUUID()}`;
  const receipt: ControlReceipt = { passed: false, failure: null, label, pid: null, readErrno: null, cpuRatio: null, birthStable: false, exitObserved: false, killerPid: null,
    event: null, classes: [], jobRemoved: false, fileRemoved: false, startedAt: new Date().toISOString(), finishedAt: null };
  const target = `gui/${uid}/${label}`;
  const plist = join(directory, `${label}.plist`);
  const started = new Date(Date.now() - 2000);
  try {
    if (uid === undefined) throw new Error("user identity unavailable");
    await writeFile(plist, controlPlist(label, process.execPath), { mode: 0o600 });
    await ownedCommand(["/bin/launchctl", "bootstrap", `gui/${uid}`, plist], undefined, 10_000);
    await exerciseControl(receipt, target);
  } catch (error) { receipt.failure = String(error); }
  finally { await removeControl(receipt, target, plist); }
  if (receipt.failure) return finishControl(receipt);
  if (!receipt.jobRemoved || !receipt.fileRemoved) return finishControl(receipt, "control job or file was not removed");
  const pid = receipt.pid ?? 0;
  const accept = (service: string) => service === target ? "control" as const : undefined;
  for (let attempt = 0; attempt < 4 && !receipt.event; attempt++) {
    // The unified log persists asynchronously; poll briefly for the control's own record.
    if (attempt) await Bun.sleep(1000);
    const query = await queryLaunchd(pid, started, new Date(Date.now() + 2000), accept);
    receipt.event = provingEvent(query, receipt) ?? null;
    receipt.classes = Array.from(new Set(query.events.filter(event => provingEvent({ events: [event], ignored: 0 }, receipt)).map(event => event.kind)));
  }
  return finishControl(receipt, receipt.event ? undefined : "no launchd record named the control PID, launchctl caller and signal 9");
}

function finishControl(receipt: ControlReceipt, failure?: string): ControlReceipt {
  receipt.failure ??= failure ?? null;
  receipt.passed = receipt.failure === null;
  receipt.finishedAt = new Date().toISOString();
  return receipt;
}

export function macNative(): NativePort {
  return { read: readProcess, candidates: webContentCandidates, control: launchdControl,
    query: (pid, service, start, end) => queryLaunchd(pid, start, end, service === "webcontent" ? webContentService : () => undefined) };
}
