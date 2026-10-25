import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: "exit" | "cancel" | "deadline";
  stdout: string;
  stderr: string;
  diagnostic: string;
};

/** Own the embed harness and its inherited Node/Bun process group, not just its leader. */
export class RuntimeJsCommands {
  private disposed = false;
  private cleanupFailure: Error | undefined;
  private readonly active = new Set<{ stop: () => void; closed: Promise<void> }>();
  private readonly exit = () => { for (const command of this.active) command.stop(); };
  private readonly interrupt = () => { void this.dispose().then(this.onInterrupt).finally(() => process.exit(1)); };

  constructor(private readonly onInterrupt = () => {}) {
    process.on("exit", this.exit);
    process.on("SIGINT", this.interrupt);
    process.on("SIGTERM", this.interrupt);
    process.on("SIGHUP", this.interrupt);
  }

  async cancel(): Promise<void> {
    const commands = Array.from(this.active);
    for (const command of commands) command.stop();
    await Promise.all(commands.map(command => command.closed));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    process.off("exit", this.exit);
    process.off("SIGINT", this.interrupt);
    process.off("SIGTERM", this.interrupt);
    process.off("SIGHUP", this.interrupt);
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  async run(command: string, args: readonly string[], options: {
    phase: string;
    timeout: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onStderr?: (text: string) => void;
  }): Promise<CommandResult> {
    if (this.disposed) throw new Error("Runtime JS command owner is disposed");
    options.signal?.throwIfAborted();
    const child = spawn(command, args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let reason: "exit" | "cancel" | "deadline" = "exit";
    let failure: Error | undefined;
    const kill = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (!isGone(error)) throw error; }
    };
    const stop = () => { if (reason === "exit") reason = "cancel"; kill(); };
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    let finish = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    const owned = { stop, closed: done };
    this.active.add(owned);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); options.onStderr?.(chunk.toString()); });
    child.once("error", error => { failure = error; });
    // A leader can exit while a descendant still holds its output pipes open.
    child.once("exit", kill);
    options.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { reason = "deadline"; kill(); }, options.timeout);
    try {
      await closed;
      clearTimeout(timer);
      const result = {
        exitCode: child.exitCode, signal: child.signalCode, reason,
        stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
      };
      const diagnostic = `runtime-js phase=${options.phase} command=${command} status=${result.exitCode} signal=${result.signal} reason=${reason}\n${failure?.message ?? ""}\n${result.stderr}`;
      try { await groupGone(child.pid); }
      catch (error) {
        this.cleanupFailure = new Error(`${diagnostic}\n${String(error)}`);
        throw this.cleanupFailure;
      }
      return { ...result, diagnostic };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      kill();
      this.active.delete(owned);
      finish();
    }
  }
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

async function groupGone(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const deadline = performance.now() + 500;
  while (performance.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (error) { if (isGone(error)) return; throw error; }
    await delay(10);
  }
  throw new Error(`runtime-js teardown: process group ${pid} survived SIGKILL`);
}
