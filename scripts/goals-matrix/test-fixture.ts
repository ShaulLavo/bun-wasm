import { phases, type Attempt, type Phase } from "./model";
function evidence(phase: Phase): unknown {
  switch (phase) {
    case "startup": return { ready: true, status: "ready", engine: "browser", agent: "fixture" };
    case "install": case "build": return { done: true, code: 0, error: null, output: "fixture" };
    case "dev": return { url: "http://fixture/" };
    case "render": return { matched: true, text: "fixture" };
    case "click": return { before: "count 0", after: "count 1" };
    case "hot-reload": return { updated: "updated", before: "count 1", sameDocument: true, manualNavigations: 0, result: { matched: true, text: "updated" } };
    case "preview": return { rendered: { matched: true, text: "updated" }, clicked: { before: "0", after: "1" } };
    case "cleanup": return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
}
export function completeAttempt(): Attempt {
  return { startedAt: "now", finishedAt: "now", browser: { browserName: "chrome" }, phases: phases.map(phase => ({ phase, status: "pass", evidence: evidence(phase), startedAt: "now", durationMs: 1 })) };
}
