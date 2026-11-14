import { clock, type Clock, type SafariProtocolFact } from "./safari-protocol";
import type { NativePort } from "./safari-causal-native";
import type { Transport } from "./scoped-transport";

export type Subscription = ReturnType<typeof import("./safari-exit-syscalls").openExit>;
type Target = Readonly<{ pid: number; birth: string }>;
export type Phase = "workload" | "foreground-cleanup" | "page-cleanup" | "session-delete" | "driver-teardown" | "app-teardown" | "final-drain";
export type RecordEntry = Readonly<{ sequence: number; at: Clock; phase: Phase; target: Target | null; kind: string; value: unknown }>;
export type Sink = { write(entry: RecordEntry, signal: AbortSignal): Promise<void>; close(signal: AbortSignal): Promise<void> };
type Outcome<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown };
type Joined<T> = { kind: "joined"; outcome: Outcome<T>; timedOut: boolean } | { kind: "unjoined" };
export type CleanupStep = { phase: Phase; run(signal: AbortSignal): Promise<void> };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try { return { kind: "ok", value: await run() }; }
  catch (error) { return { kind: "error", error }; }
}

// A timeout withdraws admission, then allows a separate join interval. A promise
// ignoring cancellation is reported unjoined; it can never produce cleanup proof.
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<Joined<T>> {
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = outcome(() => run(cancellation.signal));
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { cancellation.abort(new Error("Lifecycle deadline")); resolve(null); }, timeoutMs); });
  const first = await Promise.race([pending, deadline]);
  clearTimeout(timer);
  if (first !== null) return { kind: "joined", outcome: first, timedOut: false };
  const grace = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const joined = await Promise.race([pending, grace]);
  clearTimeout(timer);
  return joined === null ? { kind: "unjoined" } : { kind: "joined", outcome: joined, timedOut: true };
}

export class ExitOwner {
  readonly records: RecordEntry[] = [];
  readonly degraded: { source: string; error: unknown }[] = [];
  readonly cleanup: { phase: Phase; result: Joined<void> }[] = [];
  private target: Target | null = null;
  private subscription: Subscription | undefined;
  private attachmentAttempted = false;
  private phase: Phase = "workload";
  private timer: ReturnType<typeof setInterval> | undefined;
  private writes = Promise.resolve();
  private writerJoined = true;
  private writerFailed = false;
  private writerClosed = false;
  private descriptor: "not-opened" | "open" | "closed" | "unproved" = "not-opened";
  private finishing: Promise<void> | undefined;
  private settled = false;
  private lateFacts = 0;
  private firstInvalid: SafariProtocolFact | null = null;

  constructor(private readonly options: {
    native: Pick<NativePort, "read">; open(pid: number): Subscription;
    sink: Sink; pollMs?: number; joinMs?: number;
  }) {}

  private emit(kind: string, value: unknown): void {
    if (this.settled) { this.lateFacts++; return; }
    const entry: RecordEntry = { sequence: this.records.length + 1, at: clock(), phase: this.phase, target: this.target, kind, value };
    this.records.push(entry);
    this.writes = this.writes.then(() => this.write(entry));
  }

  private async write(entry: RecordEntry): Promise<void> {
    if (!this.writerJoined || this.writerFailed) return;
    const result = await bounded(signal => this.options.sink.write(entry, signal), this.options.joinMs ?? 20_000);
    if (result.kind === "unjoined") this.writerJoined = false;
    if (result.kind === "unjoined" || result.timedOut || result.outcome.kind === "error") {
      this.writerFailed = true;
      this.degraded.push({ source: "writer", error: result });
    }
  }

  // Called only by the snapshot hook after unique association and the maintained final check.
  attach = (target: Target): void => {
    if (this.finishing) throw new Error("Exit observer already settled");
    if (this.attachmentAttempted) throw new Error("Exit attachment attempted twice");
    this.attachmentAttempted = true;
    this.target = Object.freeze({ ...target });
    const before = this.readBirth("before", target.pid);
    if (before?.birth !== target.birth) throw new Error("Exit attachment birth mismatch before registration");
    try { this.subscription = this.options.open(target.pid); }
    catch (error) { this.descriptor = "unproved"; this.emit("registration-failed", { error }); throw error; }
    this.descriptor = "open";
    this.emit("registration", this.subscription.registration);
    const after = this.readBirth("after", target.pid);
    if (after?.birth !== target.birth) throw new Error("Exit attachment birth mismatch after registration");
    this.timer = setInterval(() => this.drain(), this.options.pollMs ?? 250);
  };

  private readBirth(moment: "before" | "after", pid: number) {
    try {
      const reading = this.options.native.read(pid);
      this.emit(`birth-${moment}-registration`, { reading, at: clock() });
      return reading;
    } catch (error) { this.emit(`birth-${moment}-registration`, { error, at: clock() }); throw error; }
  }

  protocol = (fact: SafariProtocolFact): void => {
    this.emit("protocol", fact);
    if (fact.result.kind === "valid" || this.firstInvalid) return;
    this.firstInvalid = fact;
    this.emit("first-invalid", fact);
    this.drain();
  };

  drain(): void {
    if (!this.subscription || this.descriptor !== "open") return;
    try {
      const poll = this.subscription.poll();
      this.emit("exit-poll", poll);
    } catch (error) { this.degraded.push({ source: "poll", error }); }
  }

  boundary(phase: Phase): void {
    this.drain();
    this.phase = phase;
    this.emit("dispatch-boundary", { phase });
  }

  // Every existing transport member is preserved, including future members.
  transport(inner: Transport): Transport {
    return { ...inner,
      beginCleanup: admission => { this.boundary("foreground-cleanup"); return inner.beginCleanup?.(admission); },
      closePreview: admission => { this.boundary("page-cleanup"); return inner.closePreview(admission); },
      close: (...args) => { this.boundary("session-delete"); return inner.close(...args); },
    };
  }

  // This scope surrounds withNativeDriver, not just withSafariCausalCapture.
  // Neither capture settlement nor this owner waits for process exit delivery.
  async run<T>(operation: () => Promise<T>, teardown: readonly CleanupStep[] = []): Promise<T> {
    const result = await outcome(() => this.attempt(operation, teardown));
    await this.finish();
    if (result.kind === "error") throw result.error;
    return result.value;
  }

  async attempt<T>(operation: () => Promise<T>, teardown: readonly CleanupStep[] = []): Promise<T> {
    let result = await outcome(operation);
    for (const step of teardown) result = await this.step(step, result);
    if (result.kind === "error") throw result.error;
    return result.value;
  }

  private async step<T>(step: CleanupStep, result: Outcome<T>): Promise<Outcome<T>> {
    this.boundary(step.phase);
    const settled = await bounded(step.run, this.options.joinMs ?? 20_000);
    this.cleanup.push({ phase: step.phase, result: settled });
    this.emit("cleanup-settled", { phase: step.phase, result: settled });
    if (result.kind === "error") return result;
    if (settled.kind === "unjoined") return { kind: "error", error: new Error(`Unjoined ${step.phase}`) };
    if (settled.timedOut && settled.outcome.kind === "ok") return { kind: "error", error: new Error(`Timed out ${step.phase}`) };
    return settled.outcome.kind === "error" ? settled.outcome : result;
  }

  finish(): Promise<void> { return this.finishing ??= this.settle(); }

  private async settle(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.boundary("final-drain");
    if (this.subscription && this.descriptor === "open") this.closeDescriptor(this.subscription);
    this.emit("observer-settled", { descriptor: this.descriptor });
    await this.writes;
    if (!this.writerJoined) { this.settled = true; return; }
    const closed = await bounded(signal => this.options.sink.close(signal), this.options.joinMs ?? 20_000);
    if (closed.kind === "unjoined") this.writerJoined = false;
    this.writerClosed = closed.kind === "joined" && closed.outcome.kind === "ok" && !closed.timedOut;
    if (!this.writerClosed) this.degraded.push({ source: "writer-close", error: closed });
    this.settled = true;
  }

  private closeDescriptor(subscription: Subscription): void {
    this.descriptor = "unproved";
    try { subscription.close(); this.descriptor = "closed"; }
    catch (error) { this.degraded.push({ source: "close", error }); }
    this.emit("descriptor-close", subscription.closeReceipt);
  }

  proof() {
    const childrenJoined = this.cleanup.every(item => item.result.kind === "joined");
    const cleanupCompleted = this.cleanup.every(item => item.result.kind === "joined" && !item.result.timedOut && item.result.outcome.kind === "ok");
    const writersSucceeded = !this.degraded.some(item => item.source === "writer" || item.source === "writer-close");
    return { descriptor: this.descriptor, childrenJoined, writersJoined: this.writerJoined, writersClosed: this.writerClosed,
      cleanupCompleted, observation: this.degraded.length ? "degraded" : "ok",
      lateFacts: this.lateFacts,
      state: this.settled && cleanupCompleted && writersSucceeded && this.writerJoined && this.writerClosed && this.descriptor !== "open" && this.descriptor !== "unproved" ? "settled" : "unproved",
      eventCount: this.records.filter(entry => entry.kind === "exit-poll" && typeof entry.value === "object" && entry.value !== null && "kind" in entry.value && entry.value.kind === "event").length,
      firstInvalid: this.firstInvalid, degraded: this.degraded };
  }
}
