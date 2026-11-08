import { boxId, inventory, browsers, engines, frameworks, type Box } from "./catalog";
import { validateDeadlines, type DeadlinePolicy } from "./deadlines";
import { object, text, observed } from "./evidence";
export const phases = ["startup", "install", "dev", "render", "click", "hot-reload", "build", "preview", "cleanup"] as const;
export type Phase = typeof phases[number];
export type PhaseResult = { phase: Phase; startedAt: string; durationMs: number; timeoutMs: number } & (
  | { status: "pass"; evidence: unknown }
  | { status: "fail"; error: string }
);
export type Attempt = { startedAt: string; finishedAt: string; phases: PhaseResult[]; browser: Record<string, unknown> };
export type Cell = Box & { attempts: Attempt[] } & (
  | { status: "pending"; reason: string }
  | { status: "not runnable yet"; reason: string; discovery: unknown }
  | { status: "pass" }
  | { status: "fail"; phase: Phase; error: string }
);
export interface Report {
  schema: 2;
  run: string;
  createdAt: string;
  command: string;
  deadlines: DeadlinePolicy;
  source: { commit: string; dirty: boolean; assets: unknown };
  cells: Cell[];
  resources?: { kind: "asset-server"; host: string; pid: number; stopped: boolean }[];
}
export function initialCells(): Cell[] { return inventory().map(box => ({ ...box, status: "pending", reason: "Not selected or not attempted yet", attempts: [] })); }
export function finish(box: Box, attempt: Attempt, earlier: readonly Attempt[] = []): Cell {
  const identity = { framework: box.framework, browser: box.browser, engine: box.engine };
  const attempts = earlier.concat([attempt]);
  const failed = attempt.phases.find(result => result.status === "fail");
  if (failed?.status === "fail") return { ...identity, attempts, status: "fail", phase: failed.phase, error: failed.error };
  assertBrowser(box, attempt.browser);
  if (phases.some(phase => !attempt.phases.some(result => result.phase === phase && result.status === "pass"))) throw new Error("Cannot pass a box with missing phase evidence");
  for (const result of attempt.phases) {
    if (result.status === "pass") observed(result.phase, result.evidence, box.engine);
  }
  const cleaned = attempt.phases.find(result => result.phase === "cleanup");
  if (!cleaned || cleaned.status !== "pass") throw new Error("Missing cleanup evidence");
  const cleanup = object(cleaned.evidence);
  if (cleanup.browserClosed !== true) throw new Error("A passing attempt must close its owned browser");
  return { ...identity, attempts, status: "pass" };
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}
function phaseResult(value: unknown, engine: string, framework: string, deadlines: DeadlinePolicy): PhaseResult {
  const data = object(value);
  const phase = phases.find(phase => phase === data.phase);
  if (!phase || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0) throw new Error("Invalid phase or duration");
  const timeoutMs = phase === "cleanup" ? deadlines.cleanupTimeoutMs : phase === "install" ? (deadlines.installTimeouts[framework] ?? deadlines.timeoutMs) : deadlines.timeoutMs;
  if (data.timeoutMs !== timeoutMs) throw new Error("Phase timeout differs from report deadline policy");
  const base = { phase, timeoutMs: data.timeoutMs, startedAt: text(data.startedAt), durationMs: data.durationMs };
  if (data.status === "fail") return { ...base, status: "fail", error: text(data.error) };
  if (data.status !== "pass") throw new Error("Unknown phase status");
  observed(phase, data.evidence, engine);
  return { ...base, status: "pass", evidence: data.evidence };
}
function attempt(value: unknown, engine: string, framework: string, deadlines: DeadlinePolicy): Attempt {
  const data = object(value);
  return { startedAt: text(data.startedAt), finishedAt: text(data.finishedAt), browser: object(data.browser), phases: array(data.phases).map(value => phaseResult(value, engine, framework, deadlines)) };
}
function validateCell(value: unknown, deadlines: DeadlinePolicy): Box {
  const data = object(value);
  const browser = browsers.find(value => value === data.browser), engine = engines.find(value => value === data.engine);
  const framework = frameworks.find(value => value.id === data.framework)?.id;
  if (!browser || !engine || !framework) throw new Error("Unknown box");
  const box = { framework, browser, engine };
  const attempts = array(data.attempts).map(value => attempt(value, engine, framework, deadlines));
  if (data.status === "pending") { text(data.reason); if (attempts.length) throw new Error("Pending box has attempts"); return box; }
  if (data.status === "not runnable yet") { text(data.reason); object(data.discovery); return box; }
  if (data.status !== "pass" && data.status !== "fail") throw new Error("Unknown cell status");
  const latest = attempts.at(-1);
  if (!latest) throw new Error("Attempted status without an attempt");
  const rebuilt = finish(box, latest, attempts.slice(0, -1));
  if (rebuilt.status !== data.status) throw new Error("Status differs from phase evidence");
  if (rebuilt.status === "fail" && (rebuilt.error !== data.error || rebuilt.phase !== data.phase)) throw new Error("First failure was not preserved");
  return box;
}
export function validateReport(value: unknown): asserts value is Report {
  const report = object(value);
  if (report.schema !== 2) throw new Error("Unknown report schema");
  for (const field of ["run", "createdAt", "command"]) text(report[field]);
  const source = object(report.source); text(source.commit);
  if (typeof source.dirty !== "boolean" || source.assets === undefined) throw new Error("Invalid source identity");
  const deadlines = validateDeadlines(report.deadlines);
  const expected = new Set(inventory().map(boxId));
  const cells = array(report.cells);
  if (cells.length !== expected.size) throw new Error(`Report must include all ${expected.size} boxes`);
  for (const cell of cells) {
    const box = validateCell(cell, deadlines);
    if (!expected.delete(boxId(box))) throw new Error(`Unknown or duplicate box ${boxId(box)}`);
  }
  for (const value of report.resources === undefined ? [] : array(report.resources)) validateResource(value);
}
function validateResource(value: unknown): void {
  const resource = object(value); text(resource.host);
  if (resource.kind !== "asset-server" || typeof resource.pid !== "number" || !Number.isSafeInteger(resource.pid) || resource.pid < 1 || typeof resource.stopped !== "boolean") throw new Error("Invalid owned resource");
}

function assertBrowser(box: Box, capabilities: Record<string, unknown>): void {
  const name = String(capabilities.browserName ?? "").toLowerCase();
  const expected = box.browser === "iphone-safari" ? "safari" : box.browser;
  if (name !== expected) throw new Error(`Wrong browser label: ${name} cannot report ${box.browser}`);
  if (box.browser === "iphone-safari" && (String(capabilities.platformName).toLowerCase() !== "ios" || capabilities["safari:useSimulator"] !== true)) throw new Error("iPhone Safari requires native iOS simulator capabilities");
  if (box.browser === "safari" && !["mac", "macos"].includes(String(capabilities.platformName).toLowerCase())) throw new Error("Desktop Safari requires native macOS capabilities");
}
