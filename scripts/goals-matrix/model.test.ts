import { deadlinePolicy } from "./deadlines";
import { completeAttempt } from "./test-fixture";
import { describe, expect, test } from "bun:test";
import { inventory, browsers, engines } from "./catalog";
import { finish, initialCells, phases, validateReport, type Report } from "./model";
import { markdown } from "./report";
import { execute } from "./execute";
import { options } from "./run";
import { prerequisites } from "./discovery";
const box = { framework: "vite-react", browser: "chrome", engine: "browser" } as const;
const complete = completeAttempt;
function report(): Report {
  return { schema: 2, run: "test-only", createdAt: new Date().toISOString(), command: "test", deadlines: deadlinePolicy(180_000), source: { commit: "test", dirty: false, assets: {} }, cells: initialCells() };
}
describe("honest goals matrix", () => {
  test("keeps every one of the 260 boxes, including unavailable engines and Safari", () => {
    expect(inventory()).toHaveLength(260);
    expect(new Set(inventory().map(item => JSON.stringify(item))).size).toBe(260);
    for (const browser of browsers) expect(inventory().filter(item => item.browser === browser)).toHaveLength(65);
    for (const engine of engines) expect(inventory().filter(item => item.engine === engine)).toHaveLength(52);
  });
  test("requires actual evidence from every phase and cleanup before passing", () => {
    for (const omitted of phases) {
      const attempt = complete();
      attempt.phases = attempt.phases.filter(result => result.phase !== omitted);
      expect(() => finish(box, attempt)).toThrow("missing phase evidence");
    }
  });
  test("never overwrites first failure with later cleanup failure", () => {
    const attempt = complete();
    attempt.phases[0] = { phase: "startup", status: "fail", startedAt: "now", durationMs: 0, timeoutMs: 180_000, error: "real error" };
    attempt.phases.push({ phase: "cleanup", status: "fail", startedAt: "now", durationMs: 0, timeoutMs: 20_000, error: "cleanup error" });
    expect(finish(box, attempt)).toMatchObject({ status: "fail", phase: "startup", error: "real error" });
    const retried = finish(box, complete(), [attempt]);
    expect(retried.attempts).toHaveLength(2);
    expect(retried.attempts[0]?.phases[0]).toMatchObject({ error: "real error" });
  });
  test("rejects synthetic pass, omitted boxes, and duplicate cells", () => {
    const result = report();
    result.cells[0] = { ...box, status: "pass", attempts: [] };
    expect(() => validateReport(result)).toThrow();
    result.cells = initialCells().slice(1);
    expect(() => validateReport(result)).toThrow("260");
    result.cells = initialCells();
    result.cells[1] = result.cells[0]!;
    expect(() => validateReport(result)).toThrow("duplicate");
  });
  test("native Safari and iPhone Safari are not WebKit labels or emulated iPhones", () => {
    const text = markdown(report());
    expect(text).toContain("Desktop Safari (native)");
    expect(text).toContain("iPhone Safari (native simulator)");
    expect(() => options(["--asset-source=test", "--browsers=webkit"])).toThrow();
    expect(() => options(["--asset-source=test", "--browsers=chromium"])).toThrow();
  });
  test("missing template is discovered, never invented as a framework run", () => {
    expect(prerequisites(box, { root: "/does-not-exist" })).toMatchObject({ reason: expect.stringContaining("Missing built playground template") });
  });
  test("startup failure still closes the owned browser, and close failure stays red", async () => {
    let closed = false;
    const cell = await execute({ box, framework: { id: "vite-react", label: "test", template: "vite-react", source: "src/App.tsx", selector: "h1", text: "test", button: "button", clicked: "output" }, url: "http://localhost/", timeoutMs: 100,
      async createTransport() { return {
        capabilities: { browserName: "chrome" },
        async navigate() { throw new Error("navigation failed"); },
        async evaluate<T>(): Promise<T> { throw new Error("no page"); },
        async openPreview() {}, async useHost() {}, async usePreview() {}, async closePreview() {},
        async close() { closed = true; throw new Error("owned browser close failed"); },
      }; },
      async saveLog() {},
    });
    expect(closed).toBe(true);
    expect(cell).toMatchObject({ status: "fail", phase: "startup", error: "Error: navigation failed" });
    expect(cell.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "fail" });
  });
});
