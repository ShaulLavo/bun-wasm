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
  holders: RowsFact;
  sharedGuests: RowsFact;
  contradictions: RowsFact;
}
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
  try {
    let owner = value;
    for (let depth = 0; owner !== null && typeof owner === "object" && depth < 4; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      owner = Object.getPrototypeOf(owner);
    }
  } catch { /* Unknown diagnostic fields stay unavailable. */ }
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
  const result = row(value, ["label", "scope", "state", "declaredBytes", "grownBytes", "phase", "fence", "chargedBytes", "initialPages", "actualMaximumPages", "sourceMaximumPages", "bytes", "observed", "budget"]);
  for (const key of ["shape", "owner", "aliases", "continuations"]) {
    const nested = row(data(value, key), ["kind", "initial", "maximum", "maximumPages", "pages", "bytes", "length", "directory", "pid", "reserved", "transferred", "retained", "active"]);
    for (const [name, value] of Object.entries(nested)) if (value !== null) result[`${key}.${name}`] = value;
  }
  return result;
}
function ledgerFact(runtime: ProcessRuntime): LedgerFact {
  const sampleStartedAt = now();
  try {
    const value = runtime.sharedMemory.snapshot();
    const totals = row(value, ["budgetBytes", "reservedBytes", "availableBytes", "awaitingReleaseBytes", "debtBytes", "effectiveBudgetBytes"]);
    totals.platform = scalar(data(data(value, "platform"), "kind"));
    const holders = sample(() => value.holders, ledgerRow);
    const sharedGuests = sample(() => value.sharedGuests, ledgerRow);
    const contradictions = sample(() => value.contradictions, ledgerRow);
    return { sampleStartedAt, sampleEndedAt: now(), availability: "observed", totals,
      holders, sharedGuests, contradictions };
  } catch {
    const unavailable = () => sample(() => undefined, ledgerRow);
    return { sampleStartedAt, sampleEndedAt: now(), availability: "unavailable", totals: null, holders: unavailable(), sharedGuests: unavailable(), contradictions: unavailable() };
  }
}

/** Synchronous API snapshots after launchWorker throws, before Bun adapter cleanup starts.
 * These APIs reconcile bookkeeping. They are neither a native census nor physical memory.
 */
export function launchFailureFact(error: unknown, context: RuntimeProcessContext, service: ProcessService, runtime: ProcessRuntime, memoryGroup: "new" | "inherit" | null, attempt: number): LaunchFailureFact {
  const time = now();
  const refusal = data(error, "refusal");
  const groups = sample(() => service.memoryGroups(), groupRow);
  let worker: Row | undefined;
  const workers = sample(() => {
    const values = service.workerMemory();
    worker = row(values.find(value => value.pid === context.pid), workerFields);
    return values;
  }, value => row(value, workerFields));
  return {
    time, attempt, attemptScope: "bun-launcher module instance", memoryGroup,
    process: { ...row(context, ["pid", "parentPid", "job"]), rootPid: worker?.rootPid ?? null, directory: worker?.directory ?? null,
      executable: text(context.request.executable), cwd: text(context.request.cwd) },
    error: errorFact(error), refusal: { kind: text(data(refusal, "kind")), label: text(data(refusal, "label")), cause: errorFact(data(refusal, "cause")) },
    groups, workers, ledger: ledgerFact(runtime), cleanupError: null,
  };
}

/** Validate and detach the scalar-only fact before retaining a caller's value. */
export function copyLaunchFailure(value: LaunchFailureFact): LaunchFailureFact | null {
  try {
    const copy: LaunchFailureFact = {
      time: value.time, attempt: value.attempt, attemptScope: value.attemptScope, memoryGroup: value.memoryGroup,
      process: row(value.process, Object.keys(value.process)), error: errorFact(value.error),
      refusal: { kind: text(value.refusal.kind), label: text(value.refusal.label), cause: errorFact(value.refusal.cause) },
      groups: copyRows(value.groups), workers: copyRows(value.workers), ledger: { sampleStartedAt: value.ledger.sampleStartedAt,
        sampleEndedAt: value.ledger.sampleEndedAt, availability: value.ledger.availability,
        totals: value.ledger.totals ? row(value.ledger.totals, Object.keys(value.ledger.totals)) : null,
        holders: copyRows(value.ledger.holders), sharedGuests: copyRows(value.ledger.sharedGuests), contradictions: copyRows(value.ledger.contradictions) },
      cleanupError: value.cleanupError ? errorFact(value.cleanupError) : null,
    };
    return encoder.encode(JSON.stringify(copy)).byteLength <= maxLaunchFailureBytes ? copy : null;
  } catch { return null; }
}
function copyRows(value: RowsFact): RowsFact {
  return { sampleStartedAt: value.sampleStartedAt, sampleEndedAt: value.sampleEndedAt, availability: value.availability,
    rowCount: value.rowCount, rowsTruncated: value.rowsTruncated,
    rows: value.rows.map(entry => row(entry, Object.keys(entry))),
  };
}
