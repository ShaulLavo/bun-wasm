import { browsers } from "./catalog";
import { cleanupTimeoutMs, parseTimeout, type RecordedDeadlinePolicy } from "./deadlines";
import { object, text } from "./evidence";
import { finish, phases, validateCellEvidence, type Cell, type RecordedBox, type Report } from "./model";

export type ArchivedReport = Omit<Report, "cells" | "deadlines"> & { cells: Cell<RecordedBox>[]; deadlines: RecordedDeadlinePolicy };
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}
function identifier(value: unknown): string {
  const id = text(value);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Invalid archived box identifier");
  return id;
}
function archivedBox(value: unknown): RecordedBox {
  const data = object(value), browser = browsers.find(browser => browser === data.browser);
  if (!browser) throw new Error("Unknown archived browser");
  return { framework: identifier(data.framework), browser, engine: identifier(data.engine) };
}
export function recordedTime(value: string): number {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(time)) throw new Error(`Invalid recorded time: ${value}`);
  return time;
}
function validateHistory(cell: Cell<RecordedBox>): void {
  for (const attempt of cell.attempts) {
    const start = recordedTime(attempt.startedAt), end = recordedTime(attempt.finishedAt);
    if (end < start || !attempt.phases.length) throw new Error("Invalid archived attempt time or empty phases");
    let previous = -1, failed = false;
    for (const phase of attempt.phases) {
      const index = phases.indexOf(phase.phase), at = recordedTime(phase.startedAt);
      if (index <= previous || at < start || at > end || (failed && phase.phase !== "cleanup")) throw new Error("Invalid archived phase order or time");
      previous = index; failed ||= phase.status === "fail";
    }
    finish(cell, attempt);
  }
}
function archivedDeadlines(value: unknown, frameworks: readonly string[]): RecordedDeadlinePolicy {
  const data = object(value);
  if (typeof data.timeoutMs !== "number" || data.cleanupTimeoutMs !== cleanupTimeoutMs) throw new Error("Invalid archived deadline policy");
  parseTimeout(String(data.timeoutMs));
  const installTimeouts = timeoutMap(data.installTimeouts, frameworks);
  if (data.buildTimeouts === undefined) return { timeoutMs: data.timeoutMs, installTimeouts, cleanupTimeoutMs };
  return { timeoutMs: data.timeoutMs, installTimeouts, buildTimeouts: timeoutMap(data.buildTimeouts, frameworks), cleanupTimeoutMs };
}
function timeoutMap(value: unknown, frameworks: readonly string[]): Record<string, number> {
  const data = object(value);
  if (Object.keys(data).length !== frameworks.length) throw new Error("Archived policy must match its framework inventory");
  return Object.fromEntries(frameworks.map(framework => {
    const timeout = data[framework];
    if (typeof timeout !== "number") throw new Error(`Missing archived deadline for ${framework}`);
    return [framework, parseTimeout(String(timeout))];
  }));
}
function validateInventory(boxes: readonly RecordedBox[]): string[] {
  const frameworks = Array.from(new Set(boxes.map(box => box.framework)));
  const browserSet = new Set(boxes.map(box => box.browser)), engineSet = new Set(boxes.map(box => box.engine));
  const ids = new Set(boxes.map(box => JSON.stringify(box)));
  if (ids.size !== boxes.length) throw new Error("Unknown or duplicate archived box");
  if (!boxes.length || boxes.length !== frameworks.length * browserSet.size * engineSet.size) throw new Error("Incomplete archived inventory");
  return frameworks;
}
export function validateArchive(value: unknown): asserts value is ArchivedReport {
  const report = object(value);
  if (report.schema !== 2) throw new Error("Only schema 2 run reports can be projected");
  for (const field of ["run", "createdAt", "command"]) text(report[field]);
  recordedTime(text(report.createdAt));
  const source = object(report.source); text(source.commit);
  if (typeof source.dirty !== "boolean" || source.assets === undefined) throw new Error("Invalid source identity");
  const cells = array(report.cells), boxes = cells.map(archivedBox);
  const deadlines = archivedDeadlines(report.deadlines, validateInventory(boxes));
  cells.forEach((cell, index) => {
    validateCellEvidence(cell, boxes[index]!, deadlines);
    validateHistory(cell);
  });
  for (const resource of report.resources === undefined ? [] : array(report.resources)) {
    const data = object(resource); text(data.host);
    if (data.kind !== "asset-server" || typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid < 1 || typeof data.stopped !== "boolean") throw new Error("Invalid owned resource");
  }
}
