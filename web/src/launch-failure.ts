import type { ProcessService, RuntimeProcessContext } from "waffle";
import type { ProcessRuntime } from "../../src/process-runtime.js";

type Scalar = string | number | boolean | null;
type Row = Record<string, Scalar>;
export interface ErrorFact { name: string | null; message: string | null; stack: string | null }
interface RowsFact {
  sampleStartedAt: number;
  sampleEndedAt: number;
  availability: "observed" | "unavailable";
  rowCount: number | null;
  rowsTruncated: boolean;
  rows: Row[];
}
interface LedgerFact {
  sampleStartedAt: number;
  sampleEndedAt: number;
  availability: "observed" | "unavailable";
  totals: Row | null;
  holderSummary: HolderSummary;
  holders: RowsFact;
  sharedGuests: RowsFact;
  contradictions: RowsFact;
}
type HolderKind = "capacity-promise" | "headroom" | "fixed-buffer" | "growable-buffer" | "request-arena"
  | "group-fixed" | "group-growable" | "shared-guest" | "guest-declaration" | "unknown";
type HolderState = "live" | "draining" | "idle" | "awaiting-collection" | "debt" | "unknown";
interface HolderAggregate {
  kind: HolderKind;
  count: number;
  declaredBytes: number | null;
  maximumBytes: number | null;
  knownCurrentBytes: number | null;
  unknownCurrentCount: number;
  states: Record<HolderState, number>;
}
type HolderSummary = { availability: "unavailable" } | {
  availability: "observed";
  rowCount: number;
  unknownShapeCount: number;
  unknownStateCount: number;
  requestArenaActivity: "unavailable";
  kinds: HolderAggregate[];
};
export interface LaunchFailureFact {
  time: number;
  attempt: number;
  attemptScope: "bun-launcher module instance";
  memoryGroup: "new" | "inherit" | null;
  process: Row;
  error: ErrorFact;
  refusal: { kind: string | null; label: string | null; cause: ErrorFact };
  groups: RowsFact;
  workers: RowsFact;
  ledger: LedgerFact;
  cleanupError: ErrorFact | null;
}

const now = Date.now.bind(Date);
const maxText = 192;
const maxRows = 8;
const maxSampleBytes = 2048;
export const maxLaunchFailureBytes = 32_768;
const encoder = new TextEncoder();

// Read data properties only. Diagnostics never invoke an error's getters or coercion hooks.
function data(value: unknown, key: string): unknown {
  try { return dataProperty(value, key); }
  catch { /* Unknown diagnostic fields stay unavailable. */ }
}
function dataProperty(value: unknown, key: string): unknown {
  let owner = value;
  for (let depth = 0; owner !== null && typeof owner === "object" && depth < 4; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    owner = Object.getPrototypeOf(owner);
  }
}
function text(value: unknown, limit = maxText): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}
function scalar(value: unknown): Scalar {
  if (typeof value === "string") return text(value);
  if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
export function errorFact(error: unknown): ErrorFact {
  return { name: text(data(error, "name")), message: text(data(error, "message"), 384), stack: text(data(error, "stack"), 768) };
}
function row(value: unknown, fields: readonly string[]): Row {
  return Object.fromEntries(fields.map(key => [key, scalar(data(value, key))]));
}
const workerFields = ["pid", "parentPid", "rootPid", "job", "directory", "bytes"];
const groupFields = ["id", "members", "reserved", "retained", "regions", "pins", "published", "holds", "watches", "committedBytes", "memberPages", "bypassed", "freeBytes"];
function groupRow(value: unknown): Row {
  const pids = data(value, "pids");
  const result = row(value, groupFields);
  result.pidCount = Array.isArray(pids) ? pids.length : null;
  result.pidsTruncated = Array.isArray(pids) && pids.length > maxRows;
  if (Array.isArray(pids)) for (let index = 0; index < Math.min(pids.length, maxRows); index++) result[`pid${index}`] = scalar(data(pids, String(index)));
  return result;
}
function sample(read: () => unknown, project: (value: unknown) => Row): RowsFact {
  const sampleStartedAt = now();
  try {
    const values = read();
    if (!Array.isArray(values)) throw new TypeError("Snapshot rows unavailable");
    const result: RowsFact = { sampleStartedAt, sampleEndedAt: now(), availability: "observed", rowCount: values.length, rowsTruncated: false, rows: [] };
    appendRows(result, values, project);
    result.sampleEndedAt = now();
    return result;
  } catch { return { sampleStartedAt, sampleEndedAt: now(), availability: "unavailable", rowCount: null, rowsTruncated: false, rows: [] }; }
}
function appendRows(result: RowsFact, values: unknown[], project: (value: unknown) => Row): void {
  for (let index = 0; index < Math.min(values.length, maxRows); index++) {
    const entry = project(data(values, String(index)));
    if (encoder.encode(JSON.stringify(result.rows.concat([entry]))).byteLength > maxSampleBytes) break;
    result.rows.push(entry);
  }
  result.rowsTruncated = result.rows.length < values.length;
}
function ledgerRow(value: unknown): Row {
  const result = row(value, ["label", "scope", "state", "declaredBytes", "grownBytes", "phase", "fence", "chargedBytes", "initialPages", "actualMaximumPages", "sourceMaximumPages", "requestedBytes", "totalChargedBytesAfterRefund"]);
  for (const key of ["shape", "owner", "aliases", "continuations"]) appendNestedRow(result, key, data(value, key));
  return result;
}
function appendNestedRow(result: Row, key: string, value: unknown): void {
  const nested = row(value, ["kind", "initial", "maximum", "maximumPages", "pages", "bytes", "length", "directory", "pid", "reserved", "transferred", "retained", "active"]);
  for (const [name, entry] of Object.entries(nested)) if (entry !== null) result[`${key}.${name}`] = entry;
}
function holderKind(value: unknown): HolderKind {
  const label = data(value, "label"), kind = data(data(value, "shape"), "kind");
  if (label === "headroom") return "headroom";
  if (kind === "fixed" || kind === "growable") return label === "memory-group" ? `group-${kind}` : "unknown";
  if (kind === "growable-buffer") return label === "request-arena" ? "request-arena" : "growable-buffer";
  if (kind === "guest") return "guest-declaration";
  if (kind === "capacity-promise" || kind === "fixed-buffer" || kind === "shared-guest") return kind;
  return "unknown";
}
function holderState(value: unknown): HolderState {
  const state = data(value, "state");
  return state === "live" || state === "draining" || state === "idle" || state === "awaiting-collection" || state === "debt" ? state : "unknown";
}
function byteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function addBytes(total: number | null, value: number | null): number | null {
  return total === null || value === null ? null : byteCount(total + value);
}
function maximumBytes(value: unknown, kind: HolderKind): number | null {
  const shape = data(value, "shape");
  if (kind === "fixed-buffer") return byteCount(data(shape, "length"));
  if (kind === "growable-buffer" || kind === "request-arena") return byteCount(data(shape, "maximum"));
  const key = kind === "group-fixed" ? "pages" : kind === "shared-guest" ? "actualMaximumPages" : "maximumPages";
  const pages = byteCount(data(shape, key));
  return pages === null || pages > 65_536 ? null : pages * 65_536;
}
function newAggregate(kind: HolderKind): HolderAggregate {
  return { kind, count: 0, declaredBytes: 0, maximumBytes: 0, knownCurrentBytes: 0, unknownCurrentCount: 0,
    states: { live: 0, draining: 0, idle: 0, "awaiting-collection": 0, debt: 0, unknown: 0 } };
}
function appendHolder(aggregate: HolderAggregate, value: unknown, state: HolderState): void {
  aggregate.count++;
  aggregate.states[state]++;
  aggregate.declaredBytes = addBytes(aggregate.declaredBytes, byteCount(data(value, "declaredBytes")));
  const kind = aggregate.kind;
  if (kind === "capacity-promise" || kind === "headroom" || kind === "guest-declaration" || kind === "unknown") {
    aggregate.maximumBytes = null;
    aggregate.knownCurrentBytes = null;
    return;
  }
  aggregate.maximumBytes = addBytes(aggregate.maximumBytes, maximumBytes(value, kind));
  const current = byteCount(data(value, "grownBytes"));
  if (current === null) aggregate.unknownCurrentCount++;
  else aggregate.knownCurrentBytes = addBytes(aggregate.knownCurrentBytes, current);
}
function holderSummary(values: unknown): HolderSummary {
  if (!Array.isArray(values)) return { availability: "unavailable" };
  const kinds = new Map<HolderKind, HolderAggregate>();
  let unknownShapeCount = 0, unknownStateCount = 0;
  for (let index = 0; index < values.length; index++) {
    const value = data(values, String(index)), kind = holderKind(value), state = holderState(value);
    if (kind === "unknown") unknownShapeCount++;
    if (state === "unknown") unknownStateCount++;
    const aggregate = kinds.get(kind) ?? newAggregate(kind);
    kinds.set(kind, aggregate);
    appendHolder(aggregate, value, state);
  }
  return { availability: "observed", rowCount: values.length, unknownShapeCount, unknownStateCount,
    requestArenaActivity: "unavailable", kinds: Array.from(kinds.values()) };
}
function ledgerFact(runtime: Pick<ProcessRuntime, "sharedMemory">): LedgerFact {
  const sampleStartedAt = now();
  try {
    const value = runtime.sharedMemory.snapshot();
    const totals = row(value, ["budgetBytes", "reservedBytes", "availableBytes", "awaitingReleaseBytes", "debtBytes", "effectiveBudgetBytes"]);
    totals.platform = scalar(data(data(value, "platform"), "kind"));
    const allHolders = data(value, "holders");
    const summary = holderSummary(allHolders);
    const holders = sample(() => allHolders, ledgerRow);
    const sharedGuests = sample(() => value.sharedGuests, ledgerRow);
    const contradictions = sample(() => value.contradictions, ledgerRow);
    return { sampleStartedAt, sampleEndedAt: now(), availability: "observed", totals,
      holderSummary: summary, holders, sharedGuests, contradictions };
  } catch {
    const unavailable = () => sample(() => undefined, ledgerRow);
    return { sampleStartedAt, sampleEndedAt: now(), availability: "unavailable", totals: null,
      holderSummary: { availability: "unavailable" }, holders: unavailable(), sharedGuests: unavailable(), contradictions: unavailable() };
  }
}

/** Synchronous API snapshots after launchWorker throws, before Bun adapter cleanup starts.
 * These APIs reconcile bookkeeping. They are neither a native census nor physical memory.
 */
export function launchFailureFact(error: unknown, context: Pick<RuntimeProcessContext, "pid" | "parentPid" | "job" | "request">, service: Pick<ProcessService, "memoryGroups" | "workerMemory">, runtime: Pick<ProcessRuntime, "sharedMemory">, memoryGroup: "new" | "inherit" | null, attempt: number): LaunchFailureFact {
  const time = now();
  const refusal = data(error, "refusal");
  const originalError = errorFact(error);
  const originalRefusal = { kind: text(data(refusal, "kind")), label: text(data(refusal, "label")), cause: errorFact(data(refusal, "cause")) };
  const request = data(context, "request");
  const process: Row = { ...row(context, ["pid", "parentPid", "job"]), executable: text(data(request, "executable")), cwd: text(data(request, "cwd")) };
  const groups = sample(() => service.memoryGroups(), groupRow);
  let worker: Row | undefined;
  const workers = sample(() => {
    const values = service.workerMemory();
    worker = row(values.find(value => data(value, "pid") === process.pid), workerFields);
    return values;
  }, value => row(value, workerFields));
  return {
    time, attempt, attemptScope: "bun-launcher module instance", memoryGroup,
    process: { ...process, rootPid: worker?.rootPid ?? null, directory: worker?.directory ?? null },
    error: originalError, refusal: originalRefusal,
    groups, workers, ledger: ledgerFact(runtime), cleanupError: null,
  };
}

/** Detach scalar fields and enforce the serialized bound before retention. */
export function copyLaunchFailure(value: LaunchFailureFact): LaunchFailureFact | null {
  try {
    const copy: LaunchFailureFact = {
      time: value.time, attempt: value.attempt, attemptScope: value.attemptScope, memoryGroup: value.memoryGroup,
      process: row(value.process, Object.keys(value.process)), error: errorFact(value.error),
      refusal: { kind: text(value.refusal.kind), label: text(value.refusal.label), cause: errorFact(value.refusal.cause) },
      groups: copyRows(value.groups), workers: copyRows(value.workers), ledger: { sampleStartedAt: value.ledger.sampleStartedAt,
        sampleEndedAt: value.ledger.sampleEndedAt, availability: value.ledger.availability,
        totals: value.ledger.totals ? row(value.ledger.totals, Object.keys(value.ledger.totals)) : null,
        holderSummary: copyHolderSummary(value.ledger.holderSummary),
        holders: copyRows(value.ledger.holders), sharedGuests: copyRows(value.ledger.sharedGuests), contradictions: copyRows(value.ledger.contradictions) },
      cleanupError: value.cleanupError ? errorFact(value.cleanupError) : null,
    };
    return encoder.encode(JSON.stringify(copy)).byteLength <= maxLaunchFailureBytes ? copy : null;
  } catch { return null; }
}
function copyHolderSummary(value: HolderSummary): HolderSummary {
  if (value.availability === "unavailable") return { availability: "unavailable" };
  return { ...value, kinds: value.kinds.map(kind => ({ ...kind, states: { ...kind.states } })) };
}
function copyRows(value: RowsFact): RowsFact {
  return { sampleStartedAt: value.sampleStartedAt, sampleEndedAt: value.sampleEndedAt, availability: value.availability,
    rowCount: value.rowCount, rowsTruncated: value.rowsTruncated,
    rows: value.rows.map(entry => row(entry, Object.keys(entry))),
  };
}
