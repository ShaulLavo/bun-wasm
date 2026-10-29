import { control, createShell, SharedBridge, TerminalNewlines, type Shell } from "bash-web";
import type { Runtime } from "waffle";

export type SessionState = "starting" | "ready" | "running" | "exited" | "failed";

export type SessionOptions = {
  runtime: Runtime;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  wasmUrl: URL;
  workerUrl: URL;
  onOutput(bytes: Uint8Array): void;
  onState(state: SessionState, detail?: string): void;
};

const PASTE_LIMIT = 262144;
const CHUNK = 65536;
const PHASES: readonly SessionState[] = ["starting", "ready", "running", "exited"];

/** Connects a terminal view to one interactive shell over the shared terminal bridge. */
export class Shell {
  private readonly bridge = new SharedBridge();
  private readonly newlines = new TerminalNewlines();
  private shell?: Shell;
  private pendingShell?: Promise<Shell>;
  private readonly admission = new AbortController();
  private disposal?: Promise<void>;
  private failureMessage = "The terminal stopped unexpectedly.";
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private pendingDiscard = false;
  private phase = -1;
  private completion?: { resolve(): void; reject(error: Error): void };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private constructor(private readonly options: SessionOptions) {}

  static async create(options: SessionOptions): Promise<Shell> {
    const session = new Shell(options);
    try {
      session.resize(options.cols, options.rows);
      options.onState("starting");
      const shell = await (session.pendingShell = createShell({
        runtime: options.runtime,
        terminal: session.bridge,
        signal: session.admission.signal,
        cwd: options.cwd,
        env: options.env,
        wasmUrl: options.wasmUrl,
        workerUrl: options.workerUrl,
      }));
      if (session.disposed) throw new Error("Shell startup was cancelled.");
      session.shell = shell;
      void shell.done.then((result) => {
        if (session.disposed) return;
        if (result.error) session.failureMessage = result.error;
        session.bridge.signal();
      });
      session.pump();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  get running(): boolean {
    return this.completion !== undefined || this.phase === 2;
  }

  get lastExit(): number {
    return Atomics.load(this.bridge.state, control.status);
  }

  submit(command: string): Promise<void> {
    if (this.disposed || this.running) return Promise.reject(new Error("Shell is not ready"));
    const done = new Promise<void>((resolve, reject) => { this.completion = { resolve, reject }; });
    this.input(new TextEncoder().encode(`${command}\r`));
    return done;
  }

  input(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (this.disposed) return;
    if (bytes.length === 1 && bytes[0] === 3) {
      this.interrupt();
      return;
    }
    if (bytes.length + this.queuedBytes > PASTE_LIMIT) throw new Error("Paste exceeds the 256 KiB terminal queue");
    this.queued.push(bytes.slice());
    this.queuedBytes += bytes.length;
    this.flushInput();
  }

  /** Ctrl-C: drop typed-ahead input, then deliver SIGINT to the foreground job. */
  interrupt(): void {
    if (this.disposed) return;
    this.queued = [];
    this.queuedBytes = 0;
    this.bridge.interrupt();
    this.pendingDiscard = !this.bridge.discardInput();
    if (!this.pendingDiscard) this.bridge.resumeInput();
    this.shell?.interrupt();
    this.phase = -1;
    this.schedulePump();
  }

  resize(cols: number, rows: number): void {
    this.bridge.resize(cols, rows);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.completion?.reject(new Error(this.failureMessage));
    this.completion = undefined;
    this.admission.abort(new Error("Shell startup was cancelled."));
    clearTimeout(this.timer);
    this.bridge.close();
    this.queued = [];
    this.queuedBytes = 0;
    this.pendingDiscard = false;
    this.shell = undefined;
    return (this.disposal = (async () => {
      const shell = await this.pendingShell?.catch(() => undefined);
      await shell?.dispose();
    })());
  }

  private flushInput(): void {
    if (this.pendingDiscard) {
      if (!this.bridge.discardInput()) return;
      this.pendingDiscard = false;
      this.bridge.resumeInput();
    }
    if (this.bridge.cancelled()) return;
    while (this.queued.length) {
      const bytes = this.queued[0]!;
      const chunk = bytes.subarray(0, CHUNK);
      const accepted = this.bridge.send(chunk);
      if (!accepted) return;
      this.queuedBytes -= accepted;
      if (accepted === bytes.length) this.queued.shift();
      else this.queued[0] = bytes.subarray(accepted);
      if (accepted < chunk.length) return;
    }
  }

  private outputPending(): boolean {
    return Atomics.load(this.bridge.state, control.outputWrite) !== Atomics.load(this.bridge.state, control.outputRead);
  }

  private pump(): void {
    if (this.disposed) return;
    const sequence = Atomics.load(this.bridge.state, control.wake);
    this.flushInput();
    const output = this.bridge.drain();
    if (output.length) this.newlines.write(output, (chunk) => this.options.onOutput(chunk));
    const phase = Atomics.load(this.bridge.state, control.phase);
    const pending = this.outputPending();
    if (phase >= 3 && pending) {
      this.schedulePump();
      return;
    }
    if (phase === 4) {
      this.options.onState("failed", this.failureMessage);
      void this.dispose();
      return;
    }
    if (phase !== this.phase && !this.bridge.cancelled()) {
      this.phase = phase;
      this.options.onState(PHASES[phase] ?? "failed");
    }
    if (phase === 1 && this.queuedBytes === 0 && this.bridge.availableInput() === 0) {
      this.completion?.resolve();
      this.completion = undefined;
    }
    if (phase === 3 && !pending) {
      void this.dispose();
      return;
    }
    if (pending) this.schedulePump();
    else this.waitForActivity(sequence);
  }

  private schedulePump(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 0);
  }

  private waitForActivity(sequence: number): void {
    const wait = Atomics.waitAsync(this.bridge.state, control.wake, sequence);
    if (wait.async) void wait.value.then(() => this.schedulePump());
    else this.schedulePump();
  }
}
