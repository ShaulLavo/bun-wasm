import { isRowId, type Observation, type RowId, type Value } from "./rows.ts";

export interface RowReport {
  readonly id: RowId;
  readonly records: readonly Observation[];
  readonly settled: number;
  readonly armed: boolean | null;
  readonly error: string | null;
  readonly execPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected protocol object");
  return value;
}

export function executable(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new Error("Invalid executable identity");
  return value;
}

function valueItem(value: unknown): value is Value {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function observation(value: unknown): Observation {
  if (!Array.isArray(value) || value.length < 2) throw new Error("Invalid callback observation");
  const [site, frame, ...values]: unknown[] = value;
  if (typeof site !== "string" || !site || (frame !== null && typeof frame !== "string") || !values.every(valueItem)) throw new Error("Invalid callback values");
  return [site, frame, ...values];
}

function rowId(value: unknown): RowId {
  if (typeof value !== "string" || !isRowId(value)) throw new Error("Unknown protocol row");
  return value;
}

export function parseRowReport(value: unknown): RowReport {
  const data = record(value);
  if (!Array.isArray(data.records)) throw new Error("Missing callback observations");
  const records = data.records.map(observation);
  const settled = data.settled;
  if (typeof settled !== "number" || !Number.isSafeInteger(settled) || settled < 0 || settled > records.length) throw new Error("Invalid settled count");
  if (data.armed !== null && typeof data.armed !== "boolean") throw new Error("Invalid armed flag");
  if (data.error !== null && typeof data.error !== "string") throw new Error("Invalid row error");
  return { id: rowId(data.id), records, settled, armed: data.armed, error: data.error, execPath: executable(data.execPath) };
}

interface ProtocolState { records: Observation[]; settled: number | null; final: RowReport | null }

function consume(line: string, id: RowId, state: ProtocolState): void {
  const prefix = ["IORC_EVENT ", "IORC_SETTLED ", "IORC_ROW "].find(name => line.startsWith(name));
  if (!prefix) return;
  if (state.final) throw new Error("Protocol record after final row report");
  const data = record(JSON.parse(line.slice(prefix.length)));
  if (data.id !== id) throw new Error("Protocol row identity mismatch");
  if (prefix === "IORC_EVENT ") { state.records.push(observation(data.record)); return; }
  if (prefix === "IORC_SETTLED ") {
    if (state.settled !== null || data.count !== state.records.length) throw new Error("Invalid or duplicate settled marker");
    state.settled = state.records.length;
    return;
  }
  const final = parseRowReport(data);
  if (state.settled === null || final.settled !== state.settled || JSON.stringify(final.records) !== JSON.stringify(state.records)) throw new Error("Final row report does not match callback stream");
  state.final = final;
}

/** The final report is emitted at natural exit; streamed callbacks after completion stay visible. */
export function parseRowOutput(output: string, id: RowId): RowReport | null {
  const state: ProtocolState = { records: [], settled: null, final: null };
  for (const line of output.split("\n")) consume(line, id, state);
  return state.final;
}
