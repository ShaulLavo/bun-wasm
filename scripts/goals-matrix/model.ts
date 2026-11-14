import { boxId, inventory, browsers, engines, frameworks, type Box } from "./catalog";
import { cellDeadlines, startupDeadline, validateDeadlines, type DeadlinePolicy, type RecordedDeadlinePolicy } from "./deadlines";
import { object, text, observed } from "./evidence";
export const phases = ["startup", "install", "dev", "render", "click", "hot-reload", "build", "preview", "cleanup"] as const;
export type Phase = typeof phases[number];
export type PhaseResult = { phase: Phase; startedAt: string; durationMs: number; timeoutMs: number } & (
  | { status: "pass"; evidence: unknown }
  | { status: "fail"; error: string }
);
export type HarnessSetup = { startedAt: string; durationMs: number } & ({ status: "pass" } | { status: "fail"; error: string });
export type FailureStage = Phase | "harness-setup";
export type Attempt = { startedAt: string; finishedAt: string; phases: PhaseResult[]; browser: Record<string, unknown>; harnessSetup?: HarnessSetup };
export type RecordedBox = Omit<Box, "engine"> & { engine: string };
export type Cell<B extends RecordedBox = Box> = B & { attempts: Attempt[] } & (
  | { status: "pending"; reason: string }
  | { status: "not runnable yet"; reason: string; discovery: unknown }
  | { status: "pass" }
  | { status: "fail"; phase: FailureStage; error: string }
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
export function finish(box: Box, attempt: Attempt, earlier?: readonly Attempt[]): Cell;
export function finish(box: RecordedBox, attempt: Attempt, earlier?: readonly Attempt[]): Cell<RecordedBox>;
export function finish(box: RecordedBox, attempt: Attempt, earlier: readonly Attempt[] = []): Cell<RecordedBox> {
  const identity = { framework: box.framework, browser: box.browser, engine: box.engine };
  const attempts = earlier.concat([attempt]);
  if (attempt.harnessSetup?.status === "fail") {
    if (attempt.phases.some(phase => phase.phase !== "cleanup")) throw new Error("Failed harness setup cannot have product phase evidence");
    return { ...identity, attempts, status: "fail", phase: "harness-setup", error: attempt.harnessSetup.error };
  }
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
function phaseResult(value: unknown, box: RecordedBox, deadlines: RecordedDeadlinePolicy, productStartup: boolean): PhaseResult {
  const data = object(value);
  const phase = phases.find(phase => phase === data.phase);
  if (!phase || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0) throw new Error("Invalid phase or duration");
  const limits = cellDeadlines(deadlines, box);
  const timeoutMs = phase === "cleanup" ? deadlines.cleanupTimeoutMs : phase === "startup" && productStartup ? startupDeadline(deadlines, box) : phase === "install" ? limits.installTimeoutMs : phase === "build" ? limits.buildTimeoutMs : limits.timeoutMs;
  if (data.timeoutMs !== timeoutMs) throw new Error("Phase timeout differs from report deadline policy");
  const base = { phase, timeoutMs: data.timeoutMs, startedAt: text(data.startedAt), durationMs: data.durationMs };
  if (data.status === "fail") return { ...base, status: "fail", error: text(data.error) };
  if (data.status !== "pass") throw new Error("Unknown phase status");
  observed(phase, data.evidence, box.engine);
  return { ...base, status: "pass", evidence: data.evidence };
}
function attempt(value: unknown, box: RecordedBox, deadlines: RecordedDeadlinePolicy): Attempt {
  const data = object(value);
  const result: Attempt = { startedAt: text(data.startedAt), finishedAt: text(data.finishedAt), browser: object(data.browser), phases: array(data.phases).map(value => phaseResult(value, box, deadlines, data.harnessSetup !== undefined)) };
  if (data.harnessSetup !== undefined) result.harnessSetup = readHarnessSetup(data.harnessSetup);
  return result;
}
export function readHarnessSetup(value: unknown): HarnessSetup {
  const data = object(value);
  if ("timeoutMs" in data || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0) throw new Error("Invalid harness setup duration or phase limit");
  const base = { startedAt: text(data.startedAt), durationMs: data.durationMs };
  if (data.status === "pass") return { ...base, status: "pass" };
  if (data.status === "fail") return { ...base, status: "fail", error: text(data.error) };
  throw new Error("Unknown harness setup status");
}
function validateCell(value: unknown, deadlines: DeadlinePolicy): Box {
  const data = object(value);
  const browser = browsers.find(value => value === data.browser), engine = engines.find(value => value === data.engine);
  const framework = frameworks.find(value => value.id === data.framework)?.id;
  if (!browser || !engine || !framework) throw new Error("Unknown box");
  const box = { framework, browser, engine };
  validateCellEvidence(data, box, deadlines);
  return box;
}
export function validateCellEvidence(value: unknown, box: RecordedBox, deadlines: RecordedDeadlinePolicy): asserts value is Cell<RecordedBox> {
  const data = object(value);
  if (data.framework !== box.framework || data.browser !== box.browser || data.engine !== box.engine) throw new Error("Box identity differs");
  const attempts = array(data.attempts).map(value => attempt(value, box, deadlines));
  if (data.status === "pending") { text(data.reason); if (attempts.length) throw new Error("Pending box has attempts"); return; }
  if (data.status === "not runnable yet") { text(data.reason); object(data.discovery); return; }
  if (data.status !== "pass" && data.status !== "fail") throw new Error("Unknown cell status");
  const latest = attempts.at(-1);
  if (!latest) throw new Error("Attempted status without an attempt");
  const rebuilt = finish(box, latest, attempts.slice(0, -1));
  if (rebuilt.status !== data.status) throw new Error("Status differs from phase evidence");
  if (rebuilt.status === "fail" && (rebuilt.error !== data.error || rebuilt.phase !== data.phase)) throw new Error("First failure was not preserved");
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

function assertBrowser(box: RecordedBox, capabilities: Record<string, unknown>): void {
  const name = String(capabilities.browserName ?? "").toLowerCase();
  const expected = box.browser === "iphone-safari" ? "safari" : box.browser;
  if (name !== expected) throw new Error(`Wrong browser label: ${name} cannot report ${box.browser}`);
  if (box.browser === "iphone-safari" && (String(capabilities.platformName).toLowerCase() !== "ios" || capabilities["safari:useSimulator"] !== true)) throw new Error("iPhone Safari requires native iOS simulator capabilities");
  if (box.browser === "safari" && !["mac", "macos"].includes(String(capabilities.platformName).toLowerCase())) throw new Error("Desktop Safari requires native macOS capabilities");
}
