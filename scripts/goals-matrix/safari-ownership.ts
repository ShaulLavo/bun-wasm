import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Admission } from "./scope";
import type { Report } from "./model";

export type SafariOwnershipOperation =
  | { kind: "session-create" | "host-handle" | "session-delete" }
  | { kind: "preview-tab-create" }
  | { kind: "preview-tab-close"; handle: string }
  | { kind: "frame-present" | "frame-reference" | "frame-remove"; token: string }
  | { kind: "frame-select"; token: string; element: string };
type Observation = { kind: "acknowledgement" } | { kind: "unknown" }
  | { kind: "session"; sessionId: string } | { kind: "host"; handle: string }
  | { kind: "tab"; handle: string } | { kind: "element"; element: string };
type Outcome = { state: "intent" | "dispatched" }
  | { state: "acknowledged"; observation: Observation }
  | { state: "request-failed"; effect: "unknown"; errorName: string };
export type SafariOwnershipEvent = {
  sequence: number; event: number; at: string; sessionId: string | null; hostHandle: string | null;
  admission: "active" | "expired" | "unscoped"; operation: SafariOwnershipOperation; outcome: Outcome;
};
export type SafariOwnershipSink = (event: SafariOwnershipEvent) => undefined;

function identifier(value: unknown, key?: string): string | undefined {
  const selected = key && value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : key ? undefined : value;
  return typeof selected === "string" && selected.length > 0 ? selected : undefined;
}
function observation(operation: SafariOwnershipOperation, value: unknown): Observation {
  if (operation.kind === "session-create") {
    const sessionId = identifier(value, "sessionId");
    return sessionId ? { kind: "session", sessionId } : { kind: "unknown" };
  }
  const key = operation.kind === "host-handle" ? undefined : operation.kind === "preview-tab-create" ? "handle" : "element-6066-11e4-a52e-4f735466cecf";
  const id = identifier(value, key);
  if (operation.kind === "host-handle") return id ? { kind: "host", handle: id } : { kind: "unknown" };
  if (operation.kind === "preview-tab-create") return id ? { kind: "tab", handle: id } : { kind: "unknown" };
  if (operation.kind === "frame-reference") return id ? { kind: "element", element: id } : { kind: "unknown" };
  return { kind: "acknowledgement" };
}

export class SafariOwnershipWitness {
  private sequence = 0;
  private event = 0;
  private sessionId: string | null = null;
  private hostHandle: string | null = null;
  private sinkFailure: { error: unknown } | undefined;
  constructor(private readonly sink: SafariOwnershipSink) {}

  private record(event: number, operation: SafariOwnershipOperation, outcome: Outcome, admission?: Admission): void {
    const entry: SafariOwnershipEvent = { sequence: ++this.sequence, event, at: new Date().toISOString(), sessionId: this.sessionId, hostHandle: this.hostHandle,
      admission: !admission ? "unscoped" : admission.signal.aborted || Date.now() >= admission.deadline ? "expired" : "active", operation, outcome };
    try { this.sink(entry); }
    catch (error) { this.sinkFailure ??= { error }; }
  }

  async request(operation: SafariOwnershipOperation, action: () => Promise<unknown>, admission?: Admission): Promise<unknown> {
    const event = ++this.event;
    this.record(event, operation, { state: "intent" }, admission);
    let value: unknown;
    try {
      const pending = action();
      this.record(event, operation, { state: "dispatched" }, admission);
      value = await pending;
    }
    catch (error) {
      this.record(event, operation, { state: "request-failed", effect: "unknown", errorName: error instanceof Error ? error.name : "unknown" }, admission);
      throw error;
    }
    const observed = observation(operation, value);
    if (observed.kind === "session") this.sessionId = observed.sessionId;
    if (observed.kind === "host") this.hostHandle = observed.handle;
    this.record(event, operation, { state: "acknowledged", observation: observed }, admission);
    return value;
  }

  async finish(action: () => Promise<void>): Promise<void> {
    const failure: unknown[] = [];
    try { await action(); }
    catch (error) { failure.push(error); }
    if (this.sinkFailure) failure.push(new Error("Safari ownership witness sink failed", { cause: this.sinkFailure.error }));
    if (failure.length === 1) throw failure[0];
    if (failure.length > 1) throw new AggregateError(failure, `Safari cleanup and ownership witness failed: ${failure.map(String).join("; ")}`);
  }
}

export function ownershipRequest(witness: SafariOwnershipWitness | undefined, operation: SafariOwnershipOperation, action: () => Promise<unknown>, admission?: Admission): Promise<unknown> {
  return witness ? witness.request(operation, action, admission) : action();
}

export function ownershipReceipt(output: string, identity: { run: string; source: Pick<Report["source"], "commit" | "dirty">; cell: string; attempt: number }): SafariOwnershipSink {
  const capture = crypto.randomUUID();
  const path = join(output, "logs", `${identity.cell.replaceAll("/", "-")}.ownership-${capture}.jsonl`);
  return event => {
    appendFileSync(path, JSON.stringify({ schema: 1, capture, ...identity, ...event }) + "\n", { mode: 0o600 });
    return undefined;
  };
}
