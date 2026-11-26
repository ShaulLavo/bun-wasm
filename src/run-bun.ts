import type { Runtime } from "waffle";
import { startCommand, type CommandLeaderExit, type CommandOutputOptions, type CommandResult } from "waffle/command";
import type { ProcessExit, ProcessSignal } from "waffle/proc";
import { waitStatus } from "waffle/proc/wait-status";
import { ENGINE_BIN, pathEnvironment } from "./executable-paths.js";

export interface RunBunOptions {
  /** Registered Bun executable. Defaults to `/bin/bun`, the browser engine's path. */
  readonly executable?: string;
  /** Absolute working directory. Defaults to `/`. */
  readonly cwd?: string;
  /** Environment for the process. The executable's directory is prepended to `PATH`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Standard input. Omitted, the process reads end of file. A stream stays open until it ends. */
  readonly stdin?: string | Uint8Array | ReadableStream<Uint8Array>;
  /** Receives each stdout chunk as it arrives, including bytes past the capture limit. */
  readonly onStdout?: (chunk: Uint8Array) => void;
  /** Receives each stderr chunk as it arrives, including bytes past the capture limit. */
  readonly onStderr?: (chunk: Uint8Array) => void;
  /** Bytes of each stream kept in the result. Defaults to 1 MiB; 0 keeps none. */
  readonly outputLimitBytes?: number;
  /** `"join"` (default) waits for children that outlive Bun; `"stop"` stops them when Bun exits. */
  readonly onLeaderExit?: CommandLeaderExit;
  /**
   * Present stdout and stderr to Bun as a terminal, so `isTTY` is true and Bun colours its
   * output. By default they are pipes and the captured output is plain text.
   */
  readonly terminal?: boolean;
  /** Aborting stops the process tree, as `kill()` does. */
  readonly signal?: AbortSignal;
}

export interface BunRunResult {
  /**
   * The status a shell reports: the exit code, 128 plus the signal number, or 126/127 for a
   * failed start. Null only when a stop won before the process started.
   */
  readonly exitCode: number | null;
  /** Waffle's typed outcome of the Bun process, or null when it never started. */
  readonly exit: ProcessExit | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when stdout or stderr went past `outputLimitBytes`. */
  readonly truncated: boolean;
  /** True when `kill()` or the abort signal stopped the command. */
  readonly stopped: boolean;
}

export interface BunProcess {
  /** Settles once Bun, its children and their output have finished. */
  readonly result: Promise<BunRunResult>;
  /** Without a signal, stops the whole process tree. With one, sends it to Bun's job. */
  kill(signal?: ProcessSignal): Promise<void>;
}

const DEFAULT_EXECUTABLE = `${ENGINE_BIN.browser}/bun`;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

function output(limitBytes: number, onChunk?: (chunk: Uint8Array) => void): CommandOutputOptions {
  if (!onChunk) return { limitBytes };
  return { limitBytes, onChunk: chunk => { onChunk(chunk); return undefined; } };
}

function runResult(result: CommandResult): BunRunResult {
  const decoder = new TextDecoder();
  return {
    exitCode: result.exit ? waitStatus(result.exit) : null,
    exit: result.exit,
    stdout: decoder.decode(result.stdout.bytes),
    stderr: decoder.decode(result.stderr.bytes),
    truncated: result.stdout.truncated || result.stderr.truncated,
    stopped: result.stopRequested !== undefined,
  };
}

/**
 * Starts `bun <args>` as a process in the page's Runtime. Install Bun on the Runtime with
 * `installBunAdapters` first.
 */
export function startBun(runtime: Runtime, args: readonly string[], options: RunBunOptions = {}): BunProcess {
  const executable = options.executable ?? DEFAULT_EXECUTABLE;
  const limit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  const command = startCommand(runtime, executable, {
    filesystem: "runtime-root",
    // Bun registers as a compiled cooperative module, not as interruptible Wasm bytes.
    programs: "guest",
    onLeaderExit: options.onLeaderExit,
    terminal: options.terminal ?? false,
    args,
    cwd: options.cwd ?? "/",
    env: pathEnvironment(executable.slice(0, executable.lastIndexOf("/")) || "/", options.env ?? {}),
    stdin: typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
    stdout: output(limit, options.onStdout),
    stderr: output(limit, options.onStderr),
  });
  const { signal } = options;
  const stop = () => { void command.kill().catch(() => {}); };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const result = command.result.then(runResult).finally(() => signal?.removeEventListener("abort", stop));
  return {
    result,
    async kill(sent) {
      if (sent === undefined) await command.kill();
      else await command.signal(sent);
    },
  };
}

/** Runs `bun <args>` to completion and returns its exit status and output. */
export function runBun(runtime: Runtime, args: readonly string[], options: RunBunOptions = {}): Promise<BunRunResult> {
  return startBun(runtime, args, options).result;
}
