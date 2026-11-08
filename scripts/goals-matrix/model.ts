import { boxId, inventory, type Box } from "./catalog";
export const phases = ["startup", "install", "dev", "render", "click", "hot-reload", "build", "preview", "cleanup"] as const;
export type Phase = typeof phases[number];
export type PhaseResult = { phase: Phase; startedAt: string; durationMs: number } & (
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
  schema: 1;
  run: string;
  createdAt: string;
  command: string;
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
    if (result.status === "pass" && (result.evidence === undefined || result.evidence === null)) throw new Error("Cannot pass without observed evidence");
  }
  return { ...identity, attempts, status: "pass" };
}
export function validateReport(report: Report): void {
  const expected = new Set(inventory().map(boxId));
  if (report.cells.length !== expected.size) throw new Error("Report must include all 260 boxes");
  for (const cell of report.cells) {
    if (!expected.delete(boxId(cell))) throw new Error(`Unknown or duplicate box ${boxId(cell)}`);
    validateCell(cell);
  }
}
function validateCell(cell: Cell): void {
  if (cell.status === "not runnable yet" && (!cell.reason || cell.discovery === undefined)) throw new Error("Missing discovery evidence");
  if (cell.status !== "pass" && cell.status !== "fail") return;
  const latest = cell.attempts.at(-1);
  if (!latest) throw new Error("Attempted status without an attempt");
  const rebuilt = finish(cell, latest, cell.attempts.slice(0, -1));
  if (rebuilt.status !== cell.status) throw new Error("Status differs from phase evidence");
  if (rebuilt.status === "fail" && cell.status === "fail" && (rebuilt.error !== cell.error || rebuilt.phase !== cell.phase)) throw new Error("First failure was not preserved");
}

function assertBrowser(box: Box, capabilities: Record<string, unknown>): void {
  const name = String(capabilities.browserName ?? "").toLowerCase();
  const expected = box.browser === "iphone-safari" ? "safari" : box.browser;
  if (name !== expected) throw new Error(`Wrong browser label: ${name} cannot report ${box.browser}`);
  if (box.browser === "iphone-safari" && (String(capabilities.platformName).toLowerCase() !== "ios" || capabilities["safari:useSimulator"] !== true)) throw new Error("iPhone Safari requires native iOS simulator capabilities");
  if (box.browser === "safari" && !["mac", "macos"].includes(String(capabilities.platformName).toLowerCase())) throw new Error("Desktop Safari requires native macOS capabilities");
}
