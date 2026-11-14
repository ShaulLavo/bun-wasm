import { expect, spyOn, test } from "bun:test";
import { browsers, engines, frameworks, boxId, type Box } from "./catalog";
import { campaignDeadlines, cellDeadlines, deadlinePolicy, harnessSetupWatchdogMs, startupDeadline, validateDeadlines } from "./deadlines";
import { execute, type Execution } from "./execute";
import { finish, initialCells, validateReport, type Report } from "./model";
import { options } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { completeAttempt, withPlayground } from "./test-fixture";
import { project } from "./view";
import type { Transport } from "./transport";
import { Scope, type Admission } from "./scope";

const framework = frameworks[0]!;
const box: Box = { framework: framework.id, browser: "chrome", engine: "browser" };
function execution(transport: Transport, fields: Partial<Execution> = {}): Execution {
  return { box, framework, url: "http://fixture/?engine=browser", timeoutMs: 1000, startupTimeoutMs: 100,
    createTransport: async () => transport, saveLog: async () => {}, ...fields };
}
function browserCapabilities(browser: Box["browser"]): Record<string, unknown> {
  if (browser === "safari") return { browserName: "safari", platformName: "macOS" };
  if (browser === "iphone-safari") return { browserName: "safari", platformName: "iOS", "safari:useSimulator": true };
  return { browserName: browser };
}
const boxes = browsers.flatMap(browser => engines.map(engine => ({ ...box, browser, engine })));
test.each(boxes)("slow setup leaves a full product startup budget for $browser/$engine", async box => {
  await withPlayground(framework, 0, async fixture => {
    const transport = { ...fixture, capabilities: browserCapabilities(box.browser) };
    const result = await execute(execution(transport, { box, url: `http://fixture/?engine=${box.engine}`,
      createTransport: async () => { await Bun.sleep(150); return transport; } }));
    expect(result.status).toBe("pass");
    const attempt = result.attempts[0]!;
    expect(attempt.harnessSetup?.status).toBe("pass");
    expect(attempt.harnessSetup?.durationMs).toBeGreaterThanOrEqual(140);
    expect(attempt.harnessSetup).not.toHaveProperty("timeoutMs");
    expect(attempt.phases[0]).toMatchObject({ phase: "startup", status: "pass", timeoutMs: 100 });
    expect(attempt.phases.map(phase => phase.phase)).not.toContain("harness-setup");
    expect(Date.parse(attempt.phases[0]!.startedAt) - Date.parse(attempt.harnessSetup!.startedAt)).toBeGreaterThanOrEqual(140);
  }, 0, undefined, box.engine);
});

test.each(["navigation", "host readiness", "after-ready observer"])("delayed %s consumes product startup and prevents install", async stage => {
  await withPlayground(framework, 0, async fixture => {
    const pending: Promise<void>[] = [];
    const delay = () => { const work = Bun.sleep(150); pending.push(work); return work; };
    let installed = false, closed = false, observed = false;
    const transport: Transport = { ...fixture,
      async navigate(url, admission) { if (stage === "navigation") await delay(); return fixture.navigate(url, admission); },
      async evaluate<T>(expression: string, admission: Admission, options?: Parameters<Transport["evaluate"]>[2]): Promise<T> {
        if (expression.includes("function readyState") && stage === "host readiness") await delay();
        if (expression.includes("bun install")) installed = true;
        return fixture.evaluate<T>(expression, admission, options);
      },
      async close() { closed = true; await Promise.all(pending); },
    };
    const result = await execute(execution(transport, { observeStartup: async () => { observed = true; if (stage === "after-ready observer") await delay(); } }));
    expect(result).toMatchObject({ status: "fail", phase: "startup", error: expect.stringContaining("100 ms") });
    expect(result.attempts[0]?.harnessSetup?.status).toBe("pass");
    expect(result.attempts[0]?.phases[0]?.durationMs).toBeGreaterThanOrEqual(90);
    expect(result.attempts[0]?.phases.map(phase => phase.phase)).toEqual(["startup", "cleanup"]);
    expect(installed).toBe(false);
    expect(closed).toBe(true);
    expect(observed).toBe(stage === "after-ready observer");
  });
});

test("factory rejection is a setup failure with cleanup and no fake startup result", async () => {
  let saved = false;
  const result = await execute({ box, framework, url: "http://fixture/", timeoutMs: 100, startupTimeoutMs: 100,
    createTransport: async () => { throw new Error("driver creation failed"); }, saveLog: async () => { saved = true; } });
  expect(result).toMatchObject({ status: "fail", phase: "harness-setup", error: "Error: driver creation failed" });
  expect(result.attempts[0]?.harnessSetup).toMatchObject({ status: "fail", error: "Error: driver creation failed" });
  expect(result.attempts[0]?.phases).toMatchObject([{ phase: "cleanup", status: "pass", evidence: { transportCreated: false } }]);
  expect(saved).toBe(false);
});

test("already-cancelled setup never invokes a factory", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before setup"));
  let created = false;
  const result = await execute({ box, framework, url: "http://fixture/", timeoutMs: 100, startupTimeoutMs: 100, signal: controller.signal,
    createTransport: async () => { created = true; throw new Error("not reached"); }, saveLog: async () => {} });
  expect(result).toMatchObject({ status: "fail", phase: "harness-setup", error: "Error: cancelled before setup" });
  expect(created).toBe(false);
});

test("late transport close failure is retained as cleanup failure after setup cancellation", async () => {
  await withPlayground(framework, 0, async fixture => {
    const controller = new AbortController();
    let closed = 0;
    const transport: Transport = { ...fixture, async close() { closed++; throw new Error("late close failed"); } };
    const result = await execute(execution(transport, { signal: controller.signal, createTransport: async () => {
      controller.abort(new Error("cancel setup"));
      await Bun.sleep(30);
      return transport;
    } }));
    expect(result).toMatchObject({ status: "fail", phase: "harness-setup", error: "Error: cancel setup" });
    expect(result.attempts[0]?.phases).toMatchObject([{ phase: "cleanup", status: "fail", error: "Error: late close failed" }]);
    expect(closed).toBe(1);
  });
});

test("the operational setup watchdog closes a late factory without a product phase result", async () => {
  const open = Scope.open;
  const watchdog = spyOn(Scope, "open").mockImplementation((timeoutMs, parent) => open(timeoutMs === harnessSetupWatchdogMs ? 20 : timeoutMs, parent));
  try {
    await withPlayground(framework, 0, async fixture => {
      let closed = false;
      const transport: Transport = { ...fixture, async close() { closed = true; } };
      const result = await execute(execution(transport, { createTransport: async () => { await Bun.sleep(50); return transport; } }));
      expect(result).toMatchObject({ status: "fail", phase: "harness-setup", error: `Error: Harness setup watchdog expired after ${harnessSetupWatchdogMs} ms` });
      expect(result.attempts[0]?.harnessSetup).not.toHaveProperty("timeoutMs");
      expect(result.attempts[0]?.phases.map(phase => phase.phase)).toEqual(["cleanup"]);
      expect(closed).toBe(true);
    });
  } finally { watchdog.mockRestore(); }
});

test("a wider startup budget covers delayed navigation without widening later phases", async () => {
  await withPlayground(framework, 0, async fixture => {
    const transport: Transport = { ...fixture, async navigate(url, admission) { await Bun.sleep(150); return fixture.navigate(url, admission); } };
    const result = await execute(execution(transport, { timeoutMs: 100, startupTimeoutMs: 500, installTimeoutMs: 700, buildTimeoutMs: 800 }));
    expect(result.status).toBe("pass");
    for (const phase of result.attempts[0]!.phases) {
      const limit = phase.phase === "startup" ? 500 : phase.phase === "install" ? 700 : phase.phase === "build" ? 800 : phase.phase === "cleanup" ? 20_000 : 100;
      expect(phase.timeoutMs).toBe(limit);
    }
  });
});

test("startup policies and native forwarding are independent of other phase limits", () => {
  const normal = campaignDeadlines(), widened = campaignDeadlines(undefined, {}, 12_345);
  expect(widened.cellTimeouts).toEqual(normal.cellTimeouts);
  expect(widened.installTimeouts).toEqual(normal.installTimeouts);
  expect(widened.buildTimeouts).toEqual(normal.buildTimeouts);
  expect(widened.cleanupTimeoutMs).toBe(normal.cleanupTimeoutMs);
  for (const box of boxes) expect(startupDeadline(widened, box)).toBe(12_345);
  expect(startupDeadline(normal, box)).toBe(cellDeadlines(normal, box).timeoutMs);
  expect(validateDeadlines(widened)).toEqual(widened);
  expect(() => validateDeadlines({ ...normal, startupTimeouts: {} })).toThrow("full inventory");
  expect(() => validateDeadlines({ ...normal, startupTimeoutMs: -1 })).toThrow("Invalid calibrated timeout");
  const config = options(["--asset-source=fixture", "--startup-timeout-ms=12345", "--mac-lane=startup-unit", "--mac-thread=startup-unit"]);
  const forwarded = options(nativeRunnerArgs(config, "/remote"));
  expect(forwarded.startupTimeoutMs).toBe(12_345);
  expect(forwarded.timeoutMs).toBeUndefined();
  expect(() => options(["--asset-source=fixture", "--startup-timeout-ms=NaN"])).toThrow("startup-timeout-ms");
});

test("report validation and read-only projection preserve both measurement definitions", () => {
  const at = "2026-11-14T00:00:00.000Z";
  const historical = completeAttempt();
  historical.startedAt = historical.finishedAt = at;
  for (const phase of historical.phases) phase.startedAt = at;
  const current = structuredClone(historical);
  current.startedAt = "2026-11-14T00:00:10.000Z";
  current.finishedAt = "2026-11-14T00:00:15.000Z";
  current.harnessSetup = { status: "pass", startedAt: current.startedAt, durationMs: 4000 };
  for (const phase of current.phases) phase.startedAt = "2026-11-14T00:00:14.000Z";
  current.phases[0]!.timeoutMs = 500;
  const report: Report = { schema: 2, run: "startup-shapes", createdAt: at, command: "unit fixture", source: { commit: "fixture", dirty: false, assets: {} },
    deadlines: deadlinePolicy(180_000, {}, 500), cells: initialCells() };
  const index = report.cells.findIndex(cell => boxId(cell) === boxId(box));
  report.cells[index] = finish(box, current, [historical]);
  expect(() => validateReport(report)).not.toThrow();
  const input = { path: "/fixture/TABLE.json", contents: new TextEncoder().encode(JSON.stringify(report)) };
  const view = project([input], [box]);
  expect(view.inputs[0]?.report.cells[index]?.attempts).toEqual([historical, current]);
  current.harnessSetup = { status: "fail", startedAt: current.startedAt, durationMs: 1, error: "setup failed" };
  current.phases = current.phases.filter(phase => phase.phase === "cleanup");
  report.cells[index] = finish(box, current);
  expect(() => validateReport(report)).not.toThrow();
  expect(project([{ ...input, contents: new TextEncoder().encode(JSON.stringify(report)) }], [box]).cells[0]?.overall).toEqual({ status: "fail", phase: "harness-setup", error: "setup failed" });
  expect(() => validateReport({ ...report, cells: report.cells.map(cell => cell === report.cells[index] ? { ...cell, attempts: [{ ...current, harnessSetup: { ...current.harnessSetup, timeoutMs: 500 } }] } : cell) })).toThrow("phase limit");
});
