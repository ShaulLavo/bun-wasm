import { isDeepStrictEqual } from "node:util";
import { frameworks, inventory, boxId, type Box } from "./catalog";
import { object, text } from "./evidence";
import reviewed from "./cell-deadlines.json";
import type { CalibrationMetadata, CellLimits } from "./calibration-model";
import { hangCaps } from "./generate-deadlines";

export const cleanupTimeoutMs = 20_000;
interface FrameworkDeadlinePolicy {
  timeoutMs: number;
  installTimeouts: Record<string, number>;
  buildTimeouts: Record<string, number>;
  cleanupTimeoutMs: typeof cleanupTimeoutMs;
}
interface CellDeadlinePolicy {
  calibration: CalibrationMetadata;
  cellTimeouts: Record<string, CellLimits>;
  overrides: { timeoutMs: number | null; installTimeouts: Record<string, number>; buildTimeoutMs?: number | null };
}
type PolicyCalibration = CellDeadlinePolicy | { calibration?: never; cellTimeouts?: never; overrides?: never };
export type DeadlinePolicy = FrameworkDeadlinePolicy & PolicyCalibration;
export type RecordedDeadlinePolicy = Omit<FrameworkDeadlinePolicy, "buildTimeouts"> & { buildTimeouts?: Record<string, number> } & PolicyCalibration;
export function parseTimeout(value: string, option = "timeout-ms"): number {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) throw new Error(`${option} must be an integer from 100 through 900000`);
  return timeoutMs;
}
export function parseInstallTimeouts(value: string | undefined): Record<string, number> {
  if (value === undefined) return {};
  const entries = new Map<string, number>();
  for (const entry of value.split(",")) {
    const [name, duration, extra] = entry.split(":");
    const framework = frameworks.find(item => item.id === name)?.id;
    if (!framework || duration === undefined || !/^\d+$/.test(duration) || extra !== undefined) throw new Error(`Expected install-timeout-ms=framework:milliseconds, received ${entry}`);
    if (entries.has(framework)) throw new Error(`Repeated install timeout for ${framework}`);
    entries.set(framework, parseTimeout(duration, "install-timeout-ms"));
  }
  return Object.fromEntries(entries);
}
export function deadlinePolicy(timeoutMs?: number, overrides: Readonly<Record<string, number>> = {}, buildTimeoutMs = hangCaps.buildTimeoutMs): FrameworkDeadlinePolicy {
  return { timeoutMs: timeoutMs ?? hangCaps.timeoutMs, installTimeouts: Object.fromEntries(frameworks.map(framework => [framework.id, overrides[framework.id] ?? timeoutMs ?? hangCaps.installTimeoutMs])),
    buildTimeouts: Object.fromEntries(frameworks.map(framework => [framework.id, buildTimeoutMs])), cleanupTimeoutMs };
}
export function campaignDeadlines(timeoutMs?: number, installs: Readonly<Record<string, number>> = {}, buildTimeoutMs?: number): FrameworkDeadlinePolicy & CellDeadlinePolicy {
  const defaults = deadlinePolicy(timeoutMs, installs, buildTimeoutMs);
  const cellTimeouts = Object.fromEntries(reviewed.cells.map(cell => [`${cell.framework}/${cell.browser}/${cell.engine}`, {
    timeoutMs: timeoutMs ?? cell.limits.timeoutMs,
    installTimeoutMs: installs[cell.framework] ?? (timeoutMs === undefined ? cell.limits.installTimeoutMs : timeoutMs),
    buildTimeoutMs: buildTimeoutMs ?? cell.limits.buildTimeoutMs,
  }]));
  return { ...defaults, calibration: calibrationMetadata(reviewed.metadata), cellTimeouts, overrides: { timeoutMs: timeoutMs ?? null, installTimeouts: { ...installs }, buildTimeoutMs: buildTimeoutMs ?? null } };
}
export function cellDeadlines(policy: RecordedDeadlinePolicy, box: Pick<Box, "framework" | "browser"> & { engine: string }): CellLimits {
  if (policy.cellTimeouts) {
    const cell = policy.cellTimeouts[`${box.framework}/${box.browser}/${box.engine}`];
    if (!cell) throw new Error("Missing cell deadline policy");
    return cell;
  }
  return { timeoutMs: policy.timeoutMs, installTimeoutMs: policy.installTimeouts[box.framework] ?? policy.timeoutMs, buildTimeoutMs: policy.buildTimeouts?.[box.framework] ?? policy.timeoutMs };
}
function positiveTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Invalid cell timeout");
  return value;
}
function calibrationMetadata(value: unknown): CalibrationMetadata {
  const data = object(value);
  if (data.kind === "hang-caps") return { kind: "hang-caps", decision: text(data.decision), decisionDate: text(data.decisionDate) };
  const source = object(data.source);
  if (typeof data.margin !== "number" || data.margin < 0 || data.margin > 1 || !/^[a-f0-9]{64}$/.test(text(source.sha256))) throw new Error("Invalid calibration provenance");
  return { decision: text(data.decision), decisionDate: text(data.decisionDate), margin: data.margin, selection: text(data.selection),
    source: { path: text(source.path), sha256: text(source.sha256), run: text(source.run), createdAt: text(source.createdAt) } };
}
function validateCellPolicy(data: Record<string, unknown>, policy: DeadlinePolicy): DeadlinePolicy {
  if (data.calibration === undefined && data.cellTimeouts === undefined && data.overrides === undefined) return policy;
  const cells = object(data.cellTimeouts), overrides = object(data.overrides), installs = object(overrides.installTimeouts);
  if (overrides.timeoutMs !== null && typeof overrides.timeoutMs !== "number") throw new Error("Invalid phase override");
  if (overrides.timeoutMs !== null) parseTimeout(String(overrides.timeoutMs));
  if (overrides.buildTimeoutMs !== undefined && overrides.buildTimeoutMs !== null) {
    if (typeof overrides.buildTimeoutMs !== "number") throw new Error("Invalid build override");
    parseTimeout(String(overrides.buildTimeoutMs), "build-timeout-ms");
  }
  const buildOverride = overrides.buildTimeoutMs === undefined ? {} : { buildTimeoutMs: overrides.buildTimeoutMs === null ? null : Number(overrides.buildTimeoutMs) };
  const installTimeouts = Object.fromEntries(Object.entries(installs).map(([id, value]) => {
    if (!frameworks.some(framework => framework.id === id) || typeof value !== "number") throw new Error("Unknown or invalid install override");
    return [id, parseTimeout(String(value))];
  }));
  if (Object.keys(cells).length !== inventory().length) throw new Error("Cell deadlines must cover the full inventory");
  const cellTimeouts = Object.fromEntries(inventory().map(box => {
    const cell = object(cells[boxId(box)]);
    return [boxId(box), { timeoutMs: positiveTimeout(cell.timeoutMs), installTimeoutMs: positiveTimeout(cell.installTimeoutMs), buildTimeoutMs: positiveTimeout(cell.buildTimeoutMs) }];
  }));
  return { ...policy, calibration: calibrationMetadata(data.calibration), cellTimeouts, overrides: { timeoutMs: overrides.timeoutMs === null ? null : Number(overrides.timeoutMs), installTimeouts, ...buildOverride } };
}
export function validateDeadlines(value: unknown): DeadlinePolicy {
  const data = object(value);
  if (typeof data.timeoutMs !== "number" || data.cleanupTimeoutMs !== cleanupTimeoutMs) throw new Error("Invalid deadline policy");
  parseTimeout(String(data.timeoutMs));
  const policy: FrameworkDeadlinePolicy = { timeoutMs: data.timeoutMs, installTimeouts: frameworkTimeouts(data.installTimeouts, "install"),
    buildTimeouts: frameworkTimeouts(data.buildTimeouts, "build"), cleanupTimeoutMs };
  return validateCellPolicy(data, policy);
}
function frameworkTimeouts(value: unknown, phase: string): Record<string, number> {
  const timeouts = object(value);
  if (Object.keys(timeouts).length !== frameworks.length) throw new Error(`Deadline policy must include every framework ${phase}`);
  const normalized: Record<string, number> = {};
  for (const framework of frameworks) {
    const timeout = timeouts[framework.id];
    if (typeof timeout !== "number") throw new Error(`Missing ${phase} deadline for ${framework.id}`);
    normalized[framework.id] = parseTimeout(String(timeout));
  }
  return normalized;
}
export function sameDeadlines(first: DeadlinePolicy, second: DeadlinePolicy): boolean {
  return isDeepStrictEqual(first, second);
}
