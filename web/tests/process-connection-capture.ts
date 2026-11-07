import { SharedMemoryAdmissionError, type Runtime } from "waffle";

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
export type ConnectionRuntime = {
  filesystem: Pick<Runtime["filesystem"], "connect">;
  sharedMemory: Pick<Runtime["sharedMemory"], "snapshot">;
};
type Disposal = { scopeOrdinal: number; status: "pending" | "fulfilled" | "rejected" };
type ControllerIdentity = { kind: "root" | "parent"; pid: number; parentPid: number | null };
type LogicalSnapshot = { status: "captured"; value: Plain } | { status: "unavailable" };
export type ProcessConnectionFailure = {
  caseLabel: string;
  scopeOrdinal: number;
  controller: ControllerIdentity;
  previousScopeDisposal: Disposal | null;
  refusal: Plain;
  beforeConnect: LogicalSnapshot;
  onFailure: LogicalSnapshot;
};

function plain(value: unknown, depth = 0, budget = { nodes: 256 }): Plain {
  if (--budget.nodes < 0 || depth > 6) return "omitted";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 128);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => plain(item, depth + 1, budget));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const output: { [key: string]: Plain } = {};
  for (const key of Object.keys(value).slice(0, 16)) output[key.slice(0, 128)] = plain(Reflect.get(value, key), depth + 1, budget);
  return output;
}

function snapshot(runtime: ConnectionRuntime): LogicalSnapshot {
  try {
    const source = runtime.sharedMemory.snapshot();
    const holderCountsByLabelAndState: Record<string, Record<string, number>> = {};
    for (const holder of source.holders) {
      const states = holderCountsByLabelAndState[holder.label] ??= {};
      states[holder.state] = (states[holder.state] ?? 0) + 1;
    }
    const value = plain({ holderCountsByLabelAndState, scope: "page-wide-logical", holderCount: source.holders.length, holdersOmitted: Math.max(0, source.holders.length - 8),
      sharedGuestCount: source.sharedGuests.length, contradictionsCount: source.contradictions.length, ...source });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096) return { status: "unavailable" };
    return { status: "captured", value };
  } catch { return { status: "unavailable" }; }
}

function refusal(error: unknown): Plain {
  try {
    if (!(error instanceof SharedMemoryAdmissionError)) return null;
    const source = error.refusal;
    const detail = source.kind === "platform" || source.kind === "uncounted-platform"
      ? { ...source, cause: { name: source.cause.name, message: source.cause.message } } : source;
    return plain({ name: error.name, code: error.code, errno: error.errno, refusal: detail });
  } catch { return null; }
}

class ConnectionScope {
  constructor(private owner: ConnectionCapture, private label: string, private disposal: Disposal, private previous: Disposal | null) {}

  connect(runtime: ConnectionRuntime, identity: Parameters<Runtime["filesystem"]["connect"]>[0], controller: ControllerIdentity) {
    if (this.owner.failed) return runtime.filesystem.connect(identity);
    const beforeConnect = snapshot(runtime);
    try { return runtime.filesystem.connect(identity); }
    catch (error) {
      this.capture(runtime, controller, error, beforeConnect);
      throw error;
    }
  }

  private capture(runtime: ConnectionRuntime, controller: ControllerIdentity, error: unknown, beforeConnect: LogicalSnapshot) {
    try {
      this.owner.failed = true;
      const onFailure = snapshot(runtime);
      this.owner.failure = { caseLabel: this.label.slice(0, 128), scopeOrdinal: this.disposal.scopeOrdinal,
        controller: { kind: controller.kind, pid: controller.pid, parentPid: controller.parentPid },
        previousScopeDisposal: this.previous ? { ...this.previous } : null, refusal: refusal(error), beforeConnect, onFailure };
    } catch { /* Diagnostics never replace the original connection exception. */ }
  }

  async dispose(operation: () => Promise<void>) {
    try { await operation(); this.disposal.status = "fulfilled"; }
    catch (error) { this.disposal.status = "rejected"; throw error; }
  }
}

class ConnectionCapture {
  failed = false;
  failure: ProcessConnectionFailure | null = null;
  private ordinal = 0;
  private last: Disposal | null = null;

  read() { return this.failure; }

  scope(label: string) {
    const previous = this.last;
    const disposal: Disposal = { scopeOrdinal: ++this.ordinal, status: "pending" };
    this.last = disposal;
    return new ConnectionScope(this, label, disposal, previous);
  }
}

export function createProcessConnectionCapture() { return new ConnectionCapture(); }
export type ProcessConnectionCapture = ReturnType<typeof createProcessConnectionCapture>;
export type ProcessConnectionScope = ReturnType<ProcessConnectionCapture["scope"]>;

export function connectProcessFilesystem(runtime: ConnectionRuntime, identity: Parameters<Runtime["filesystem"]["connect"]>[0], scope: ProcessConnectionScope | undefined, controller: ControllerIdentity) {
  if (!scope) return runtime.filesystem.connect(identity);
  return scope.connect(runtime, identity, controller);
}
