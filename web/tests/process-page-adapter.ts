export const processCheckLabels: readonly string[] = Object.freeze([
  "generic-preview1-without-bun-slots",
  "cpu-default-signal-2-status-130",
  "cpu-default-signal-15-status-143",
  "cpu-default-signal-13-status-141",
  "cpu-default-signal-9-status-137",
  "epipe-keeps-own-exit-42-not-SIGPIPE-141",
  "epipe-ignored-keeps-own-exit-42-not-SIGPIPE-141",
  "handled-signal-2-keeps-own-exit-0",
  "handled-term-signal-15-keeps-own-exit-0",
  "handled-term-23-signal-15-keeps-own-exit-23",
  "handled-term-143-signal-15-keeps-own-exit-143",
  "handled-pipe-signal-13-keeps-own-exit-42",
  "ignored-PIPE-never-pends-or-revokes-and-guest-keeps-own-zero",
  "last-handler-removal-restores-default-for-next-INT",
  "explicit-default-signal-remains-typed-signal-outcome",
  "handled-INT-then-unrelated-trap-not-signal-default",
  "KILL-during-active-INT-handler-status-137",
  "mixed-job-members-apply-their-own-default-handled-ignored-dispositions",
  "delayed-first-activation-does-not-block-other-shell-task",
  "shared-module-loader-compiles-once-for-concurrent-children",
  "start-failures-are-asynchronous-127-and-126",
  "foreground-descendants-reaped-background-survives-next-command",
  "pids-never-reuse-when-completed-process-capacity-is-released",
]);

export const processCommandId = "bun-process: default";
export type ProcessRequest = { databaseName: string };

export const processCommandLimits = Object.freeze({ commandMs: 120_000, resultMs: 90_000, pageWaitMs: 10_000 });

export type ProcessObservation = { result: unknown; progress: unknown; pageErrors: unknown };
type NestedCase = { label: string; status: "pass" | "fail" | "not-run" };
export type ProcessEvaluation = {
  issues: string[];
  checks: string[];
  currentTest: string;
  cases: NestedCase[];
  pageErrors: string[];
  result: unknown;
} & ({ status: "pass" } | { status: "fail"; failure: "protocol" | "test" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== "string") return false;
  return true;
}

function nestedCases(checks: readonly string[], currentTest: string): NestedCase[] {
  const wrong = checks.findIndex((label, index) => label !== processCheckLabels[index]);
  const passed = wrong < 0 ? Math.min(checks.length, processCheckLabels.length) : wrong;
  return processCheckLabels.map((label, index) => ({
    label,
    status: index < passed ? "pass" : index === passed && label === currentTest ? "fail" : "not-run",
  }));
}

export function evaluateProcessObservation(observation: ProcessObservation): ProcessEvaluation {
  const result = isRecord(observation.result) ? observation.result : {};
  const progress = isRecord(observation.progress) ? observation.progress : {};
  const checks = isStrings(result.checks) ? result.checks.slice() : isStrings(progress.checks) ? progress.checks.slice() : [];
  const currentTest = typeof result.currentTest === "string" ? result.currentTest : typeof progress.currentTest === "string" ? progress.currentTest : "startup";
  const pageErrors = isStrings(result.errors) ? result.errors.slice() : [];
  const issues: string[] = [];
  if (!isRecord(observation.result)) issues.push("process result must be a non-null record");
  if (result.ok !== true) issues.push("processResult.ok must equal true");
  if (!isStrings(result.checks)) issues.push("processResult.checks must be a string array");
  if (checks.length !== 23) issues.push("process gate unexpectedly changed coverage: expected 23 checks");
  if (checks.length !== processCheckLabels.length || checks.some((label, index) => label !== processCheckLabels[index])) issues.push("process checks must match the complete ordered labels");
  if (!isStrings(result.errors) || pageErrors.length !== 0) issues.push("pageerror.message array must deep-equal []");
  const details = { issues, checks, currentTest, cases: nestedCases(checks, currentTest), pageErrors, result: observation.result };
  if (issues.length) return { status: "fail", failure: observation.result === undefined ? "protocol" : "test", ...details };
  return { status: "pass", ...details };
}

export function checkProcessResult(result: unknown): void {
  const evaluation = evaluateProcessObservation({ result, progress: undefined, pageErrors: undefined });
  if (evaluation.status === "fail") throw new Error(evaluation.issues.join("; "));
}

export function processResultForTransport(observation: ProcessObservation): unknown {
  if (!isRecord(observation.result)) return observation.result;
  const progress = isRecord(observation.progress) ? observation.progress : {};
  return {
    ...observation.result,
    currentTest: typeof progress.currentTest === "string" ? progress.currentTest : observation.result.currentTest,
    errors: isStrings(observation.pageErrors) ? observation.pageErrors.slice() : observation.pageErrors,
  };
}

export function processFilesystemName(run: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(run)) throw new Error("invalid process run ID");
  return `bun-process-${run}`;
}
