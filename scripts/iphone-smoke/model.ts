import { boxId, type Box } from "../goals-matrix/catalog";
import type { Attempt, PhaseResult } from "../goals-matrix/model";
import { object, observed } from "../goals-matrix/evidence";
import { deviceUDID } from "./options";
import { smokePhases } from "./cases";
type Failure = { phase: string; error: string };
type SmokeSource = { commit: string; dirty: boolean | null; assets: unknown };
export interface SmokeCase {
  id: string;
  box: Box;
  source: SmokeSource | null;
  status: "pending" | "pass" | "fail" | "blocked";
  phases: PhaseResult[];
  cleanup: PhaseResult | null;
  failures: Failure[];
  attempt: Attempt | null;
}
export interface SandboxRootOutcome {
  url: string;
  status: "pass" | "fail";
  initialMs?: number;
  reloadMs?: number;
  databases?: string[];
  error?: string;
}
export interface SmokeReport {
  schema: 1;
  kind: "manual-iphone-smoke";
  revision: string | null;
  source: SmokeSource | null;
  status: "green" | "red";
  failedPhase: string | null;
  reportPath: string;
  createdAt: string;
  finishedAt: string | null;
  cases: SmokeCase[];
  /** Live mode: `/` root sandbox on default persistent IndexedDB storage plus full reopen/reload. */
  sandboxRoot?: SandboxRootOutcome;
  failures: Failure[];
  resources: { owned: string[]; external: string[] };
  /** Live mode: the run's live requests repeated against the real origin. */
  liveOrigin?: { checked: number; mismatches: string[] };
}
/** A failure that belongs to a named smoke step rather than to a prerequisite. */
export class StepFailure extends Error {
  constructor(readonly phase: string, message: string) { super(message); }
}
export function pendingCase(box: Box, source: SmokeCase["source"]): SmokeCase {
  return { id: boxId(box), box, source, status: "pending", phases: [], cleanup: null, failures: [], attempt: null };
}
export function completedCase(box: Box, source: SmokeCase["source"], attempt: Attempt): SmokeCase {
  const failures = attempt.phases.flatMap(phase => phase.status === "fail" ? [{ phase: phase.phase, error: phase.error }] : []);
  if (!failures.length) validateSmokeEvidence(box, attempt, failures);
  return { id: boxId(box), box, source, status: failures.length ? "fail" : "pass", phases: attempt.phases,
    cleanup: attempt.phases.find(phase => phase.phase === "cleanup") ?? null, failures, attempt };
}
function validateSmokeEvidence(box: Box, attempt: Attempt, failures: Failure[]): void {
  try {
    if (attempt.phases.map(phase => phase.phase).join() !== smokePhases.join()) throw new Error("Smoke requires startup, install, dev, render, click and cleanup, in order");
    const browser = attempt.browser;
    if (browser.browserName !== "safari" || browser.platformName !== "iOS" || browser.transport !== "visible-safari-xctest" || browser["safari:useSimulator"] !== true) throw new Error("Smoke requires the visible iPhone Safari transport");
    if (browser["safari:deviceUDID"] !== deviceUDID) throw new Error("Smoke evidence identifies a different simulator");
    for (const phase of attempt.phases) if (phase.status === "pass") observed(phase.phase, phase.evidence, box.engine);
    const click = attempt.phases.find(phase => phase.phase === "click");
    if (click?.status !== "pass" || object(click.evidence).trusted !== true) throw new Error("Smoke requires a trusted native tap with a verified counter change");
  } catch (error) { failures.push({ phase: "evidence", error: String(error) }); }
}
export function unsafeToContinue(result: SmokeCase): string | undefined {
  const failedCleanup = result.failures.find(failure => failure.phase === "cleanup");
  if (failedCleanup) return `Previous case cleanup failed: ${failedCleanup.error}`;
  if (result.attempt && !result.cleanup) return "Previous case has no cleanup evidence";
  if (result.cleanup?.status === "pass") {
    try { observed("cleanup", result.cleanup.evidence, result.box.engine); }
    catch (error) { return `Previous case cleanup is unproved: ${String(error)}`; }
  }
  const device = result.failures.find(failure => failure.error.includes("T3 device command failed"));
  return device ? device.error : undefined;
}
