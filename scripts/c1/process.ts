import { spawn, type StdioOptions } from "node:child_process";
import { constants } from "node:os";
import { type ProcessOwner, describe, type DrainTimes, type ProcessIdentity } from "../process-owner.mts";

/** Production drain: a stage gets 30 seconds after TERM, then KILL for up to 10 more. */
export const STAGE_DRAIN: DrainTimes = { graceMs: 30000, forceMs: 10000 };

export class StageFailed extends Error {}
/** Owned processes outlived TERM and KILL. Their inputs must be retained, not deleted. */
export class UnsafeDrain extends Error {
  constructor(readonly survivors: readonly ProcessIdentity[]) { super(`owned processes survived drain: ${describe(survivors)}`); }
}

export interface OwnedCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** File descriptor for combined stdout and stderr; inherited otherwise. */
  readonly output?: number;
  /** Line handler for stdout; when set stdout is piped and stderr goes to `output`. */
  readonly onLine?: (line: string) => void;
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal ? 128 + constants.signals[signal] : 1);
}
function stdio(command: OwnedCommand): StdioOptions {
  const sink = command.output ?? "inherit";
  return ["ignore", command.onLine ? "pipe" : sink, sink];
}
function forwardLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  let pending = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream?.on("end", () => { if (pending) onLine(pending); });
}

/**
 * Run one command as an owned process tree. On abort, and again after an
 * ordinary exit, every owned process (including detached and reparented
 * descendants) is drained and proven gone before this resolves. The caller
 * must have enabled child subreaping.
 */
export async function runOwned(owner: ProcessOwner, command: OwnedCommand, signal: AbortSignal, drain: DrainTimes = STAGE_DRAIN): Promise<void> {
  signal.throwIfAborted();
  const [file, ...args] = command.argv;
  if (!file) throw new StageFailed("empty command");
  const child = spawn(file, args, { cwd: command.cwd, env: command.env, stdio: stdio(command), detached: true });
  if (child.pid !== undefined) owner.adopt(child.pid);
  if (command.onLine) forwardLines(child.stdout, command.onLine);
  const tracker = setInterval(() => owner.capture(), 50);
  const exited = new Promise<number>(resolve => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, exitSignal) => resolve(exitStatus(code, exitSignal)));
  });
  let onAbort = () => {};
  const aborted = new Promise<void>(resolve => { onAbort = resolve; });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // An abort must not wait for a child that ignores it: drain first, then judge.
    await Promise.race([exited, aborted]);
    const survivors = await owner.drain(drain);
    if (survivors.length > 0) throw new UnsafeDrain(survivors);
    signal.throwIfAborted();
    const status = await exited;
    if (status !== 0) throw new StageFailed(`${file} exited ${status}`);
  } finally {
    clearInterval(tracker);
    signal.removeEventListener("abort", onAbort);
  }
}
