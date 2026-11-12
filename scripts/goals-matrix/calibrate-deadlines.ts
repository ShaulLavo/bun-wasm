import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventory, boxId, type Box } from "./catalog";
import { object, text } from "./evidence";
import { recordedTime } from "./archive";
import { finish, phases, type Attempt, type PhaseResult } from "./model";
import type { Calibration, CalibrationCell, CellLimits } from "./calibration-model";
import { cellDeadlines, deadlinePolicy } from "./deadlines";

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected calibration array");
  return value;
}
function duration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid measured duration");
  return value;
}
function readPhase(value: unknown): PhaseResult {
  const data = object(value), phase = phases.find(phase => phase === data.phase);
  if (!phase || typeof data.timeoutMs !== "number" || !Number.isSafeInteger(data.timeoutMs) || data.timeoutMs < 1) throw new Error("Invalid recorded phase");
  const base = { phase, timeoutMs: data.timeoutMs, durationMs: duration(data.durationMs), startedAt: text(data.startedAt) };
  if (data.status === "pass") return { ...base, status: "pass", evidence: data.evidence };
  if (data.status === "fail") return { ...base, status: "fail", error: text(data.error) };
  throw new Error("Invalid recorded phase status");
}
function readAttempt(value: unknown): Attempt {
  const data = object(value);
  const attempt = { startedAt: text(data.startedAt), finishedAt: text(data.finishedAt), browser: object(data.browser), phases: array(data.phases).map(readPhase) };
  if (recordedTime(attempt.finishedAt) < recordedTime(attempt.startedAt)) throw new Error("Invalid attempt interval");
  return attempt;
}
type Candidate = { attempt: Attempt; reference: Extract<CalibrationCell, { kind: "calibrated" }>["attempt"] };
function candidates(value: unknown, box: Box, location: string, inputPath: string, createdAt: string): Candidate[] {
  const cell = object(value);
  if (cell.framework !== box.framework || cell.browser !== box.browser || cell.engine !== box.engine) throw new Error("Calibration history changed cell identity");
  const own = array(cell.attempts).flatMap((raw, index) => {
    const attempt = readAttempt(raw);
    if (attempt.phases.length !== phases.length || attempt.phases.some((result, index) => result.status !== "pass" || result.phase !== phases[index])) return [];
    if (finish(box, attempt).status !== "pass") return [];
    return [{ attempt, reference: { location: `${location}.attempts[${index}]`, sourceReport: cell.sourceReport === undefined ? inputPath : text(cell.sourceReport),
      sourceCreatedAt: cell.sourceCreatedAt === undefined ? createdAt : text(cell.sourceCreatedAt), startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, sha256: sha256(JSON.stringify(raw)) } }];
  });
  const history = cell.history === undefined ? [] : array(cell.history);
  return own.concat(history.flatMap((entry, index) => candidates(entry, box, `${location}.history[${index}]`, inputPath, createdAt)));
}
function compare(first: Candidate, second: Candidate): number {
  return recordedTime(first.attempt.finishedAt) - recordedTime(second.attempt.finishedAt) || recordedTime(first.attempt.startedAt) - recordedTime(second.attempt.startedAt);
}
function latest(candidates: Candidate[]): Candidate | undefined {
  candidates.sort(compare);
  const selected = candidates.at(-1);
  if (!selected) return undefined;
  for (const candidate of candidates) {
    if (compare(candidate, selected) === 0 && !isDeepStrictEqual(candidate.attempt, selected.attempt)) throw new Error("Ambiguous complete passes with equal attempt times");
  }
  return selected;
}
function measured(attempt: Attempt): CellLimits {
  const byPhase = new Map(attempt.phases.map(phase => [phase.phase, phase.durationMs]));
  const get = (phase: typeof phases[number]) => {
    const value = byPhase.get(phase);
    if (value === undefined) throw new Error("Missing measured phase");
    return value;
  };
  const shared = phases.filter(phase => phase !== "install" && phase !== "build" && phase !== "cleanup");
  return { timeoutMs: Math.max(...shared.map(get)), installTimeoutMs: get("install"), buildTimeoutMs: get("build") };
}
function calibratedCell(raw: unknown, box: Box, location: string, path: string, createdAt: string): CalibrationCell {
  const defaults = cellDeadlines(deadlinePolicy(), box);
  if (box.framework === "next" && box.engine === "spidermonkey") return { ...box, kind: "exempt-next-spidermonkey", limits: defaults };
  const selected = latest(candidates(raw, box, location, path, createdAt));
  if (!selected) return { ...box, kind: "no-complete-pass", limits: defaults };
  const measurement = measured(selected.attempt);
  const margin = (value: number, previous: number) => box.engine === "browser" ? Math.ceil(value * 1.125) : Math.min(previous, Math.ceil(value * 1.125));
  const limits = { timeoutMs: margin(measurement.timeoutMs, defaults.timeoutMs), installTimeoutMs: margin(measurement.installTimeoutMs, defaults.installTimeoutMs), buildTimeoutMs: margin(measurement.buildTimeoutMs, defaults.buildTimeoutMs) };
  if (Object.values(limits).some(value => value < 1 || !Number.isSafeInteger(value))) throw new Error("A measured category cannot produce a zero or unsafe timeout");
  return { ...box, kind: "calibrated", measured: measurement, limits, attempt: selected.reference };
}
export function calibrate(contents: string, path = "/work/reports/goals/TABLE.json"): Calibration {
  const table = object(JSON.parse(contents)), cells = array(table.cells), createdAt = text(table.createdAt);
  if (table.schema !== 2) throw new Error("Calibration requires schema 2 canonical input");
  const boxes = inventory(), indices = new Map(cells.map((raw, index) => {
    const cell = object(raw);
    return [`${text(cell.framework)}/${text(cell.browser)}/${text(cell.engine)}`, index];
  }));
  if (indices.size !== cells.length || indices.size !== boxes.length) throw new Error("Calibration requires the complete, unique cell inventory");
  return { metadata: { decision: "Owner-approved per-framework/browser/engine deadlines", decisionDate: "2026-11-11", margin: 0.125,
    selection: "Latest complete pass by finishedAt, then startedAt", source: { path, sha256: sha256(contents), run: text(table.run), createdAt } },
    cells: boxes.map(box => {
      const index = indices.get(boxId(box));
      if (index === undefined) throw new Error(`Missing calibration cell ${boxId(box)}`);
      return calibratedCell(cells[index], box, `cells[${index}]`, path, createdAt);
    }) };
}
export function calibrationMarkdown(policy: Calibration): string {
  const lines = ["# Campaign deadline changes", "", `Owner decision: ${policy.metadata.decisionDate}. Margin: ${policy.metadata.margin * 100}%. All limits are milliseconds. Cleanup stays 20000 ms.`, "",
    `Input: ${policy.metadata.source.path}. SHA-256: ${policy.metadata.source.sha256}.`, "",
    "| Framework / browser / engine | Old phase | New phase | Old install | New install | Old build | New build | Basis |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"];
  for (const cell of policy.cells) {
    const old = cellDeadlines(deadlinePolicy(), cell), next = cell.limits;
    lines.push(`| ${boxId(cell)} | ${old.timeoutMs} | ${next.timeoutMs} | ${old.installTimeoutMs} | ${next.installTimeoutMs} | ${old.buildTimeoutMs} | ${next.buildTimeoutMs} | ${cell.kind} |`);
  }
  return lines.concat([""]).join("\n");
}
if (import.meta.main) {
  const [input, output, mode, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length || (mode !== undefined && mode !== "--check" && mode !== "--markdown")) throw new Error("Usage: bun scripts/goals-matrix/calibrate-deadlines.ts FROZEN_INPUT.json OUTPUT [--check|--markdown]");
  if (resolve(input) === resolve(output)) throw new Error("Calibration output must differ from its immutable input");
  const policy = calibrate(await readFile(input, "utf8"));
  const generated = mode === "--markdown" ? calibrationMarkdown(policy) : JSON.stringify(policy, null, 2) + "\n";
  if (mode === "--check") {
    if (generated !== await readFile(output, "utf8")) throw new Error("Reviewed calibration differs; regenerate and review explicitly");
  } else await writeFile(output, generated);
}
