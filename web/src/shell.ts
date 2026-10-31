import { control, createShell, SharedBridge, TerminalNewlines, type Shell as RuntimeShell } from "bash-web";
import type { Runtime } from "waffle";

type SessionState = "starting" | "ready" | "running" | "exited" | "failed";

type SessionOptions = {
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
type Prompt = Awaited<ReturnType<RuntimeShell["waitForPrompt"]>>;

/** Connects a terminal view to one interactive shell over the shared terminal bridge. */
export class Shell {
  private readonly bridge = new SharedBridge();
  private readonly newlines = new TerminalNewlines();
  private shell?: RuntimeShell;
  private pendingShell?: Promise<RuntimeShell>;
  private readonly admission = new AbortController();
  private disposal?: Promise<void>;
  private failureMessage = "The terminal stopped unexpectedly.";
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private pendingDiscard = false;
  private phase = -1;
  private receipt?: Prompt;
  private submissions = Promise.resolve();
  private pendingSubmissions = 0;
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
      session.acceptPrompt(await shell.waitForPrompt({ signal: session.admission.signal }));
      options.onState("ready");
      void session.observePrompts(shell).catch(error => {
        if (!session.disposed) session.failureMessage = String(error);
      });
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  get running(): boolean {
    return this.pendingSubmissions > 0 || Atomics.load(this.bridge.state, control.phase) === 2;
  }

  get lastExit(): number {
    return this.receipt?.status ?? 0;
  }

  /** Resolves after the prompt receipt and queued output handoff; the view may parse writes asynchronously. */
  submit(command: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Shell is closed"));
    this.pendingSubmissions++;
    const submitted = this.submissions.then(() => this.submitOne(command));
    this.submissions = submitted.catch(() => {});
    return submitted.finally(() => { this.pendingSubmissions--; });
  }

  private async submitOne(command: string): Promise<void> {
    const shell = this.shell;
    if (!shell || this.disposed) throw new Error("Shell is closed");
    if (Atomics.load(this.bridge.state, control.phase) === 2) throw new Error("Shell is running a foreground command");
    const ready = await shell.waitForPrompt({ signal: this.admission.signal });
    this.input(new TextEncoder().encode(`\x05\x15${command}\r`));
    this.acceptPrompt(await shell.waitForPrompt({ after: ready.generation, signal: this.admission.signal }));
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

  private drainOutput(limit = 32768): void {
    const output = this.bridge.drain(limit);
    if (output.length) this.newlines.write(output, (chunk) => this.options.onOutput(chunk));
  }

  private acceptPrompt(receipt: Prompt): void {
    // A guest receipt precedes the page's output pump. Hand off the queued bytes before settling.
    this.drainOutput(this.bridge.output.length);
    this.receipt = receipt;
  }

  private async observePrompts(shell: RuntimeShell): Promise<void> {
    while (!this.disposed) {
      const next = await shell.waitForPrompt({ after: this.receipt?.generation ?? 0n, signal: this.admission.signal });
      this.acceptPrompt(next);
      this.options.onState("ready");
    }
  }

  private pump(): void {
    if (this.disposed) return;
    const sequence = Atomics.load(this.bridge.state, control.wake);
    this.flushInput();
    this.drainOutput();
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
    if (phase !== this.phase) {
      this.phase = phase;
      if (phase === 2) this.options.onState("running");
    }
    if (phase === 3 && !pending) {
      this.options.onState("exited");
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
