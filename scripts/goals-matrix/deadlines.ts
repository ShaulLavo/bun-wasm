import { isDeepStrictEqual } from "node:util";
import { frameworks, inventory, boxId, type Box } from "./catalog";
import { object, text } from "./evidence";
import reviewed from "./cell-deadlines.json";
import type { CalibrationMetadata, CellLimits } from "./calibration-model";

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
  overrides: { timeoutMs: number | null; installTimeouts: Record<string, number> };
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
export function deadlinePolicy(timeoutMs = 90_000, overrides: Readonly<Record<string, number>> = {}): FrameworkDeadlinePolicy {
  return { timeoutMs, installTimeouts: Object.fromEntries(frameworks.map(framework => [framework.id, overrides[framework.id] ?? timeoutMs])),
    buildTimeouts: Object.fromEntries(frameworks.map(framework => [framework.id, framework.id === "next" ? Math.max(timeoutMs, 110_000) : timeoutMs])), cleanupTimeoutMs };
}
export function campaignDeadlines(timeoutMs?: number, installs: Readonly<Record<string, number>> = {}): FrameworkDeadlinePolicy & CellDeadlinePolicy {
  const defaults = deadlinePolicy(timeoutMs, installs);
  const cellTimeouts = Object.fromEntries(reviewed.cells.map(cell => [`${cell.framework}/${cell.browser}/${cell.engine}`, {
    timeoutMs: timeoutMs ?? cell.limits.timeoutMs,
    installTimeoutMs: installs[cell.framework] ?? (timeoutMs === undefined ? cell.limits.installTimeoutMs : timeoutMs),
    buildTimeoutMs: timeoutMs === undefined ? cell.limits.buildTimeoutMs : defaults.buildTimeouts[cell.framework]!,
  }]));
  return { ...defaults, calibration: structuredClone(reviewed.metadata), cellTimeouts, overrides: { timeoutMs: timeoutMs ?? null, installTimeouts: { ...installs } } };
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Invalid calibrated timeout");
  return value;
}
function calibrationMetadata(value: unknown): CalibrationMetadata {
  const data = object(value), source = object(data.source);
  if (typeof data.margin !== "number" || data.margin < 0 || data.margin > 1 || !/^[a-f0-9]{64}$/.test(text(source.sha256))) throw new Error("Invalid calibration provenance");
  return { decision: text(data.decision), decisionDate: text(data.decisionDate), margin: data.margin, selection: text(data.selection),
    source: { path: text(source.path), sha256: text(source.sha256), run: text(source.run), createdAt: text(source.createdAt) } };
}
function validateCellPolicy(data: Record<string, unknown>, policy: DeadlinePolicy): DeadlinePolicy {
  if (data.calibration === undefined && data.cellTimeouts === undefined && data.overrides === undefined) return policy;
  const cells = object(data.cellTimeouts), overrides = object(data.overrides), installs = object(overrides.installTimeouts);
  if (overrides.timeoutMs !== null && typeof overrides.timeoutMs !== "number") throw new Error("Invalid phase override");
  if (overrides.timeoutMs !== null) parseTimeout(String(overrides.timeoutMs));
  const installTimeouts = Object.fromEntries(Object.entries(installs).map(([id, value]) => {
    if (!frameworks.some(framework => framework.id === id) || typeof value !== "number") throw new Error("Unknown or invalid install override");
    return [id, parseTimeout(String(value))];
  }));
  if (Object.keys(cells).length !== inventory().length) throw new Error("Cell deadlines must cover the full inventory");
  const cellTimeouts = Object.fromEntries(inventory().map(box => {
    const cell = object(cells[boxId(box)]);
    return [boxId(box), { timeoutMs: positiveTimeout(cell.timeoutMs), installTimeoutMs: positiveTimeout(cell.installTimeoutMs), buildTimeoutMs: positiveTimeout(cell.buildTimeoutMs) }];
  }));
  return { ...policy, calibration: calibrationMetadata(data.calibration), cellTimeouts, overrides: { timeoutMs: overrides.timeoutMs === null ? null : Number(overrides.timeoutMs), installTimeouts } };
}
export function validateDeadlines(value: unknown): DeadlinePolicy {
  const data = object(value), installs = object(data.installTimeouts);
  if (typeof data.timeoutMs !== "number" || data.cleanupTimeoutMs !== cleanupTimeoutMs) throw new Error("Invalid deadline policy");
  parseTimeout(String(data.timeoutMs));
  if (Object.keys(installs).length !== frameworks.length) throw new Error("Deadline policy must include every framework install");
  const normalized: Record<string, number> = {};
  for (const framework of frameworks) {
    const timeout = installs[framework.id];
    if (typeof timeout !== "number") throw new Error(`Missing install deadline for ${framework.id}`);
    normalized[framework.id] = parseTimeout(String(timeout));
  }
  const policy = deadlinePolicy(data.timeoutMs, normalized);
  const builds = object(data.buildTimeouts);
  if (Object.keys(builds).length !== frameworks.length || frameworks.some(framework => builds[framework.id] !== policy.buildTimeouts[framework.id])) throw new Error("Invalid framework build deadline policy");
  return validateCellPolicy(data, policy);
}
export function sameDeadlines(first: DeadlinePolicy, second: DeadlinePolicy): boolean {
  return isDeepStrictEqual(first, second);
}
