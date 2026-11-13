// Opt-in, observation-only causal capture for one desktop Safari cell attempt.
// It associates the ready playground page with exactly one WebContent PID and kernel start
// time, watches only that identity, records WebDriver protocol metadata, and at the end runs
// one exact-target launchd log query. It never changes the guest outcome or cleanup result.
import { appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Report } from "./model";
import type { SafariOwnershipEvent, SafariOwnershipSink } from "./safari-ownership";
import { clock, type Clock, type SafariProtocolFact, type SafariProtocolSink } from "./safari-protocol";
import { macNative, type ControlReceipt, type NativeEvent, type NativePort, type ProcessClock } from "./safari-causal-native";
import { admit, awaitWithin, type Admission } from "./scope";
import type { ScopedTransport } from "./transport";

export type CaptureIdentity = Readonly<{ run: string; source: Pick<Report["source"], "commit" | "dirty">; cell: string; attempt: number }>;
export type CaptureOptions = Readonly<{ logs: string; identity: CaptureIdentity; native?: NativePort; windowMs?: number; pollMs?: number }>;
export interface SafariCausalCapture {
  ownership(inner: SafariOwnershipSink | undefined): SafariOwnershipSink;
  readonly protocol: SafariProtocolSink;
  readonly arm: (page: ScopedTransport, admission: Admission) => Promise<void>;
}
type Target = Readonly<{ pid: number; birth: string }>;
type Scores = Readonly<{ candidates: number; matched: number; busy: readonly number[]; idle: number | null; othersMaxBusy: number; wallMs: readonly number[] }>;
type Association = { kind: "matched"; target: Target; scores: Scores } | { kind: "rejected"; reason: string; scores: Scores };
type ArmState = { kind: "unarmed" } | { kind: "blocked"; reason: string; at: Clock }
  | { kind: "armed"; target: Target; at: Clock; wall: Date; scores: Scores };
type Loss = Readonly<{ at: Clock; reason: "exited" | "birth-changed" }>;
type Degraded = Readonly<{ file: string; at: Clock; error: string }>;

export const settlementFile = "causal-capture-settlement.json";
const BUSY_MIN = 0.6, IDLE_MAX = 0.15, OTHER_MAX = 0.3;

function spin(ms: number): string {
  return `(() => { const end = performance.now() + ${ms}; let count = 0; while (performance.now() < end) count++; return count; })()`;
}
const round = (value: number) => Math.round(value * 100) / 100;

function sample(native: NativePort, candidates: readonly number[]): Map<number, ProcessClock> {
  const result = new Map<number, ProcessClock>();
  for (const pid of candidates) {
    const reading = native.read(pid);
    if (reading) result.set(pid, reading);
  }
  return result;
}

// CPU share per wall millisecond. A candidate that vanished or changed start time has no ratio.
function ratios(before: Map<number, ProcessClock>, after: Map<number, ProcessClock>, wall: number): Map<number, number> {
  const result = new Map<number, number>();
  for (const [pid, first] of before) {
    const second = after.get(pid);
    if (second && second.birth === first.birth) result.set(pid, (second.cpuMs - first.cpuMs) / wall);
  }
  return result;
}

function decide(windows: readonly Map<number, number>[], candidates: readonly number[], last: Map<number, ProcessClock>, wallMs: readonly number[]): Association {
  const ratio = (index: number, pid: number) => windows[index]?.get(pid);
  const matches = candidates.filter(pid => (ratio(0, pid) ?? 0) >= BUSY_MIN && (ratio(2, pid) ?? 0) >= BUSY_MIN && (ratio(1, pid) ?? 1) <= IDLE_MAX);
  const others = candidates.filter(pid => !matches.includes(pid)).flatMap(pid => [ratio(0, pid), ratio(2, pid)]).filter(value => value !== undefined);
  const matched = matches.length === 1 ? matches[0] : undefined;
  const scores: Scores = { candidates: candidates.length, matched: matches.length, othersMaxBusy: round(Math.max(0, ...others)), wallMs: wallMs.map(Math.round),
    busy: matched === undefined ? [] : [round(ratio(0, matched) ?? 0), round(ratio(2, matched) ?? 0)], idle: matched === undefined ? null : round(ratio(1, matched) ?? 0) };
  const birth = matched === undefined ? undefined : last.get(matched)?.birth;
  if (matched === undefined || !birth) return { kind: "rejected", reason: `${matches.length} of ${candidates.length} candidates matched`, scores };
  if (scores.othersMaxBusy > OTHER_MAX) return { kind: "rejected", reason: "another candidate was busy during a busy window", scores };
  return { kind: "matched", target: { pid: matched, birth }, scores };
}

/** One busy, idle, busy main-thread challenge. Nonmatching identities and counters stay local and are discarded. */
async function associate(page: ScopedTransport, admission: Admission, native: NativePort, windowMs: number): Promise<Association> {
  const candidates = await awaitWithin(native.candidates(), admission);
  admit(admission);
  let before = sample(native, candidates);
  const windows: Map<number, number>[] = [];
  const wallMs: number[] = [];
  for (const busy of [true, false, true]) {
    const started = performance.now();
    if (busy) await page.evaluate<number>(spin(windowMs));
    else await awaitWithin(Bun.sleep(windowMs), admission);
    const wall = performance.now() - started;
    const after = sample(native, candidates);
    admit(admission);
    windows.push(ratios(before, after, wall));
    wallMs.push(wall);
    before = after;
  }
  return decide(windows, candidates, before, wallMs);
}

class CaptureController {
  readonly id = crypto.randomUUID();
  private readonly native: NativePort;
  private readonly prefix: string;
  private readonly opened = clock();
  private state: ArmState = { kind: "unarmed" };
  private control: ControlReceipt | undefined;
  private session: string | null = null;
  private host: string | null = null;
  private loss: Loss | undefined;
  private lastConfirmed: Clock | undefined;
  private readFailed = false;
  private firstInvalid: SafariProtocolFact | undefined;
  private facts = 0;
  private late = 0;
  private closed = false;
  private nativeSummary: object | null = null;
  private poller: ReturnType<typeof setInterval> | undefined;
  private readonly degraded: Degraded[] = [];

  constructor(private readonly options: CaptureOptions) {
    this.native = options.native ?? macNative();
    this.prefix = join(options.logs, `${options.identity.cell.replaceAll("/", "-")}.causal-${this.id}`);
  }

  private append(suffix: "protocol" | "native", value: object): void {
    if (this.closed) { this.late++; return; }
    const file = `${this.prefix}.${suffix}.jsonl`;
    try { appendFileSync(file, JSON.stringify({ schema: 1, capture: this.id, ...value }) + "\n", { mode: 0o600 }); }
    catch (error) { this.degraded.push({ file, at: clock(), error: error instanceof Error ? error.name : "unknown" }); }
  }

  /** Writes the open receipt first; fleet treats an open or missing-settlement capture as unproved. */
  open(): void { this.writeSettlement("open"); }

  async qualify(): Promise<void> {
    try { this.control = await this.native.control(this.options.logs); }
    catch (error) { this.control = undefined; this.append("native", { kind: "control-error", error: error instanceof Error ? error.name : "unknown", at: clock() }); }
    this.append("native", { kind: "control", receipt: this.control ?? null, at: clock() });
  }

  readonly protocol: SafariProtocolSink = fact => {
    this.facts++;
    this.append("protocol", { armed: this.state.kind === "armed", ...fact });
    if (fact.result.kind !== "valid") this.firstInvalid ??= fact;
  };

  ownership(inner: SafariOwnershipSink | undefined): SafariOwnershipSink {
    return event => {
      this.observeOwnership(event);
      return inner?.(event);
    };
  }

  private observeOwnership(event: SafariOwnershipEvent): void {
    if (event.outcome.state !== "acknowledged") return;
    const observed = event.outcome.observation;
    if (observed.kind === "session") this.session = observed.sessionId;
    if (observed.kind === "host") this.host = observed.handle;
  }

  private block(reason: string): Error {
    this.state = { kind: "blocked", reason, at: clock() };
    this.append("native", { kind: "blocked", reason, at: this.state.at });
    return new Error(`Safari causal capture not armed: ${reason}`);
  }

  readonly arm = async (page: ScopedTransport, admission: Admission): Promise<void> => {
    if (this.state.kind !== "unarmed") throw new Error("Safari causal capture arms once per attempt");
    if (!this.control?.passed) throw this.block(`native control failed: ${this.control?.failure ?? "no receipt"}`);
    if (this.degraded.length) throw this.block("capture writer failed before the workload");
    if (!this.session || !this.host) throw this.block("owned session or host handle was not acknowledged");
    const association = await associate(page, admission, this.native, this.options.windowMs ?? 1500);
    if (association.kind === "rejected") {
      this.append("native", { kind: "association", scores: association.scores, at: clock() });
      throw this.block(`association rejected: ${association.reason}`);
    }
    const { target, scores } = association;
    if (this.native.read(target.pid)?.birth !== target.birth) throw this.block("target identity changed at attachment");
    this.state = { kind: "armed", target, at: clock(), wall: new Date(), scores };
    this.lastConfirmed = this.state.at;
    this.append("native", { kind: "armed", target, scores, session: this.session, host: this.host, at: this.state.at });
    if (this.degraded.length) throw this.block("capture writer failed at arming");
    this.poller = setInterval(() => this.poll(target), this.options.pollMs ?? 250);
  };

  // After arming only the pinned identity is read. A change ends attribution; nothing is rebound.
  private poll(target: Target): void {
    if (this.loss || this.readFailed) return;
    try {
      const reading = this.native.read(target.pid);
      if (reading?.birth === target.birth) {
        this.lastConfirmed = clock();
        this.append("native", { kind: "identity", target, reading, at: this.lastConfirmed });
        return;
      }
      this.loss = { at: clock(), reason: reading ? "birth-changed" : "exited" };
      this.append("native", { kind: "identity-lost", target, ...this.loss });
    } catch (error) {
      this.readFailed = true;
      this.degraded.push({ file: "native-reader", at: clock(), error: error instanceof Error ? error.name : "unknown" });
    }
    this.stopPoll();
  }

  private stopPoll(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  private async nativeEvents(): Promise<{ query: "not-run" | "ok" | "failed"; events: readonly NativeEvent[]; ignored: number }> {
    if (this.state.kind !== "armed") return { query: "not-run", events: [], ignored: 0 };
    const { target, wall } = this.state;
    const end = this.lastConfirmed;
    if (!end) return { query: "not-run", events: [], ignored: 0 };
    try {
      const result = await this.native.query(target.pid, "webcontent", wall, new Date(end.utc));
      const events = result.events.filter(event => {
        const time = event.eventUtc === null ? NaN : Date.parse(event.eventUtc);
        return Number.isFinite(time) && time > wall.getTime() && time < Date.parse(end.utc);
      });
      for (const event of events) this.append("native", { kind: "event", event });
      return { query: "ok", events, ignored: result.ignored + result.events.length - events.length };
    } catch (error) {
      this.append("native", { kind: "query-failed", error: error instanceof Error ? error.name : "unknown", at: clock() });
      return { query: "failed", events: [], ignored: 0 };
    }
  }

  /** Never throws: settlement is diagnostic and must not replace the cell or cleanup outcome. */
  async finish(): Promise<void> {
    try { await this.settle(); }
    catch (error) {
      this.stopPoll();
      this.degraded.push({ file: settlementFile, at: clock(), error: error instanceof Error ? error.name : "unknown" });
      try { this.writeSettlement("unproved"); } catch { /* Fleet treats the remaining open receipt as unproved. */ }
    }
  }

  private async settle(): Promise<void> {
    this.stopPoll();
    if (this.state.kind === "armed" && !this.loss) this.poll(this.state.target);
    const native = await this.nativeEvents();
    const controlled = new Set(this.control?.classes ?? []);
    const initiating = native.events.filter(event => event.caller && controlled.has(event.kind))
      .toSorted((first, second) => (first.eventUtc ?? "").localeCompare(second.eventUtc ?? ""))[0];
    this.nativeSummary = { query: native.query, events: native.events.length, ignored: native.ignored, initiating: initiating ?? "unknown",
      uncontrolled: native.events.filter(event => !controlled.has(event.kind)).length };
    this.closed = true;
    this.writeSettlement(this.control?.jobRemoved && this.control.fileRemoved ? "settled" : "unproved");
  }

  private writeSettlement(state: "open" | "settled" | "unproved"): void {
    const final = state !== "open";
    const target = this.state.kind === "armed" ? this.state.target : null;
    const receipt = { schema: 1, capture: this.id, ...this.options.identity, state, childrenJoined: final && state === "settled", writersClosed: final,
      opened: this.opened, settledAt: final ? clock() : null, anchor: { utc: this.opened.utc, monotonicMs: this.opened.monotonicMs },
      files: { protocol: basename(`${this.prefix}.protocol.jsonl`), native: basename(`${this.prefix}.native.jsonl`) },
      control: this.control ?? null, arm: this.state.kind === "armed" ? { kind: "armed", target, at: this.state.at, scores: this.state.scores } : this.state,
      session: this.session, host: this.host, lastIdentityConfirmed: this.lastConfirmed ?? null, identityLost: this.loss ?? null, firstInvalid: this.firstInvalid ?? null,
      protocolFacts: this.facts, lateFacts: this.late, native: this.nativeSummary, degraded: this.degraded };
    writeFileSync(join(this.options.logs, settlementFile), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  }
}

/**
 * Owns the capture across one whole attempt, including ordinary cleanup and session deletion.
 * The native control runs first; if it fails, `arm` rejects in startup and install never runs.
 */
export async function withSafariCausalCapture<T>(options: CaptureOptions, operation: (capture: SafariCausalCapture) => Promise<T>): Promise<T> {
  const controller = new CaptureController(options);
  controller.open();
  await controller.qualify();
  try { return await operation(controller); }
  finally { await controller.finish(); }
}
