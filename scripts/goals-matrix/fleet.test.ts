import { deadlinePolicy } from "./deadlines";
import { test, expect } from "bun:test";
import { nativePlatformBlocker, blockedCell } from "./platform";
import { combine } from "./fleet";
import { initialCells, finish, phases, type Report, type Attempt } from "./model";
function report(): Report { return { schema: 2, run: "unit", createdAt: "unit", command: "unit", deadlines: deadlinePolicy(180_000), source: { commit: "unit", dirty: false, assets: {} }, cells: initialCells() }; }
test("merging disjoint shards retains failures and all pending and unavailable boxes", () => {
  const first = report(), second = report();
  const failed: Attempt = { startedAt: "now", finishedAt: "now", browser: {}, phases: [{ phase: "dev", status: "fail", error: "real failure", startedAt: "now", durationMs: 1, timeoutMs: 180_000 }] };
  first.cells[0] = finish(first.cells[0]!, failed);
  const merged = combine(first, second);
  expect(merged.cells).toHaveLength(260);
  expect(merged.cells[0]).toMatchObject({ status: "fail", error: "real failure" });
  second.cells[0] = finish(second.cells[0]!, { ...failed, startedAt: "another", phases: [{ phase: "dev", status: "fail", error: "other failure", startedAt: "another", durationMs: 1, timeoutMs: 180_000 }] });
  expect(() => combine(first, second)).toThrow("Overlapping");
});
test("shards cannot relabel different source or assets as one run", () => {
  const first = report(), second = report(); second.source.commit = "another";
  expect(() => combine(first, second)).toThrow("sources");
});
test("a WebKit result cannot be published as real Safari or Chrome", () => {
  const attempt: Attempt = { startedAt: "now", finishedAt: "now", browser: { browserName: "webkit" }, phases: phases.map(phase => ({ phase, status: "pass", evidence: {}, startedAt: "now", durationMs: 1, timeoutMs: 180_000 })) };
  for (const browser of ["chrome", "safari", "iphone-safari"] as const) expect(() => finish({ framework: "next", browser, engine: "browser" }, attempt)).toThrow("Wrong browser");
});

test("continuation merges identical history once and preserves earlier failed attempts", () => {
  const first = report(), second = report();
  const failed: Attempt = { startedAt: "first", finishedAt: "first", browser: {}, phases: [{ phase: "dev", status: "fail", error: "original failure", startedAt: "first", durationMs: 1, timeoutMs: 180_000 }] };
  const box = first.cells[0]!;
  first.cells[0] = finish(box, failed);
  second.cells[0] = finish(box, { ...failed, startedAt: "retry" }, [failed]);
  const merged = combine(first, second);
  expect(merged.cells[0]?.attempts).toHaveLength(2);
  expect(merged.cells[0]?.attempts[0]?.phases[0]).toMatchObject({ error: "original failure" });
});

test("native platform discovery never erases an attempted failure or invents attempts", () => {
  const failed = finish({ framework: "next", browser: "safari", engine: "browser" }, { startedAt: "now", finishedAt: "now", browser: {}, phases: [{ phase: "startup", status: "fail", error: "session not created: RWIApplication", startedAt: "now", durationMs: 1, timeoutMs: 180_000 }] });
  const blocker = nativePlatformBlocker(failed);
  expect(blocker).toBeDefined();
  if (!blocker) throw new Error("Expected native platform blocker");
  const blockers = new Map([["safari", blocker]] as const);
  expect(blockedCell(failed, blockers)).toBeUndefined();
  const pending = { framework: "nuxt", browser: "safari", engine: "browser", attempts: [], status: "pending", reason: "not attempted" } as const;
  expect(blockedCell({ ...pending, attempts: [] }, blockers)).toMatchObject({ status: "not runnable yet", attempts: [], discovery: { error: "session not created: RWIApplication" } });
});
