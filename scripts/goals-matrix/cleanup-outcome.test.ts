import { expect, spyOn, test } from "bun:test";
import { ENGINES } from "../../web/src/engine-loader";
import type { PlaygroundProfile } from "../../web/src/playground/program-profile";
import { frameworks, type Box } from "./catalog";
import { execute } from "./execute";
import { Scope, type Admission } from "./scope";
import { withAdmission } from "./scope-fixture";
import { withPlayground } from "./test-fixture";
import type { Transport } from "./transport";

type TestCell = { framework: string; engine: Box["engine"]; profile: PlaygroundProfile };
const cases: TestCell[] = [
  { framework: "nuxt", engine: "jsc", profile: "shared-group" },
  { framework: "nuxt", engine: "browser", profile: "split" },
  { framework: "solidstart", engine: "browser", profile: "split" },
  { framework: "solidstart", engine: "jsc", profile: "shared-group" },
  { framework: "solidstart", engine: "spidermonkey", profile: "shared-group" },
  { framework: "tanstack-start", engine: "quickjs", profile: "shared-group" },
  { framework: "tanstack-start", engine: "jsc", profile: "shared-group" },
  { framework: "tanstack-start", engine: "spidermonkey", profile: "shared-group" },
];

test.each([false, true])("optional logging cannot fail successful cleanup, owned=%s", async owned => {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async transport => {
    let closed = false;
    const close = transport.close.bind(transport);
    transport.close = async () => { await close(); closed = true; };
    if (owned) transport.cleanup = async () => {
      await transport.close();
      return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    };
    const result = await execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" },
      url: "http://fixture/?engine=browser", timeoutMs: 2000, createTransport: async () => transport,
      async saveLog() { throw new Error("optional log write failed"); },
    });
    expect(closed).toBe(true);
    expect(result.status).toBe("pass");
  });
});

test("required owned handoff failure survives optional logging failure and successful close", async () => {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async transport => {
    let closed = false;
    const close = transport.close.bind(transport);
    transport.beginCleanup = async () => { throw new Error("required handoff failed"); };
    transport.cleanup = async () => {
      await close(); closed = true;
      return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    };
    const result = await execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" },
      url: "http://fixture/?engine=browser", timeoutMs: 2000, createTransport: async () => transport,
      async saveLog() { throw new Error("optional log write failed"); },
    });
    expect(closed).toBe(true);
    expect(result).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining("required handoff failed") });
  });
});

type Control = {
  entered: Promise<void>;
  result: ReturnType<typeof execute>;
  evaluate(expression: string): Promise<unknown>;
  advance(ms: number): void;
  expire(): void;
  closed(): boolean;
  releaseClose(): void;
};

async function control(stage: "stop" | "retirement" | "diagnostic", action: (control: Control) => Promise<void>, cell: TestCell = cases[0]!, holdClose = false): Promise<void> {
  const framework = frameworks.find(value => value.id === cell.framework)!;
  const originalNow = Date.now;
  let now = originalNow();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const open = Scope.open;
  let work: Scope | undefined;
  const scopes = spyOn(Scope, "open").mockImplementation((timeoutMs, parent) => {
    const scope = open(timeoutMs, parent);
    if (timeoutMs === 45_000) work = scope;
    return scope;
  });
  try { await withPlayground(framework, 0, transport => runControl(transport, stage, action, framework, () => now, value => { now = value; }, () => work, holdClose, cell)); }
  finally { scopes.mockRestore(); clock.mockRestore(); }
}

async function runControl(transport: Transport, stage: "stop" | "retirement" | "diagnostic", action: (control: Control) => Promise<void>, framework: typeof frameworks[number], now: () => number, setNow: (value: number) => void, work: () => Scope | undefined, holdClose: boolean, cell: TestCell): Promise<void> {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), closeGate = Promise.withResolvers<void>();
  const evaluate = transport.evaluate.bind(transport), close = transport.close.bind(transport);
  let cleaning = false, closed = false;
  const raw = (expression: string) => withAdmission(admission => evaluate(expression, admission));
  await raw(`const query = document.querySelector.bind(document);
    document.querySelector = selector => selector === '#engine' ? { value: ${JSON.stringify(cell.engine)} }
      : selector === '#status' ? { textContent: ${JSON.stringify(ENGINES[cell.engine].name + " ready")} } : query(selector);
    playground.profile = ${JSON.stringify(cell.profile)};
    globalThis.retirement = Promise.withResolvers(); globalThis.shellRetirement = Promise.withResolvers();
    globalThis.retirementStarted = Promise.withResolvers();
    globalThis.foreign = { stopped: false }; playground.runtime.dispose = () => { retirementStarted.resolve(); return retirement.promise; };
    playground.shell.dispose = () => shellRetirement.promise;
    playground.shell.runtimeSnapshot = () => { throw new Error('optional snapshot must not run'); }; void 0`);
  transport.beginCleanup = async () => { cleaning = true; };
  transport.evaluate = async <T>(expression: string, admission: Admission): Promise<T> => {
    if (cleaning && matches(stage, expression)) { entered.resolve(); await gate.promise; }
    return evaluate<T>(expression, admission);
  };
  transport.close = async () => { if (holdClose) await closeGate.promise; await close(); closed = true; };
  const result = execute({ framework, box: { framework: framework.id, browser: "chrome", engine: cell.engine },
    profile: cell.profile, url: `http://fixture/?engine=${cell.engine}`, timeoutMs: 2000, createTransport: async () => transport, async saveLog() {},
  });
  try {
    await action({ entered: entered.promise, result, closed: () => closed,
      async evaluate(expression) { const value = await raw(expression); gate.resolve(); return value; },
      advance(ms) { setNow(now() + ms); },
      expire() { const scope = work(); if (!scope) throw new Error("Cleanup work has not started"); scope.close(scope.expiryReason); gate.resolve(); },
      releaseClose() { closeGate.resolve(); },
    });
  } finally {
    gate.resolve(); closeGate.resolve();
    await raw("retirement.resolve(); shellRetirement.resolve(); void 0");
    await result;
  }
}

function matches(stage: "stop" | "retirement" | "diagnostic", expression: string): boolean {
  if (stage === "stop") return expression.includes("function stopState");
  if (stage === "retirement") return expression.includes("function disposeOwnedPlayground");
  return expression.includes("function transcript");
}

for (const cell of cases) test(`${cell.framework}/${cell.engine}/${cell.profile} accepts delayed idle only after physical barriers and close`, async () => {
  await control("stop", async c => {
    await c.entered;
    c.advance(6700);
    let finished = false;
    void c.result.then(() => { finished = true; });
    await c.evaluate("retirement.resolve(); void 0");
    expect(finished).toBe(false);
    await c.evaluate("shellRetirement.resolve(); void 0");
    c.releaseClose();
    expect((await c.result).status).toBe("pass");
    expect(c.closed()).toBe(true);
    expect(await c.evaluate("foreign.stopped")).toBe(false);
  }, cell, true);
});

test("a failed physical retirement remains failed after shell retirement and transport close", async () => {
  await control("retirement", async c => {
    await c.entered;
    let finished = false;
    void c.result.then(() => { finished = true; });
    await c.evaluate("retirement.reject(new Error('physical fence failed')); void 0");
    await c.evaluate("retirementStarted.promise");
    expect(finished).toBe(false);
    await c.evaluate("shellRetirement.resolve(); void 0");
    expect(await c.result).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining("physical fence failed") });
    expect(c.closed()).toBe(true);
  });
});

test.each(["stop", "retirement"] as const)("a genuinely hung %s fails and still closes its owned transport", async stage => {
  await control(stage, async c => {
    await c.entered;
    if (stage === "retirement") {
      await c.evaluate("void 0");
      await c.evaluate("retirementStarted.promise");
    }
    c.expire();
    expect(await c.result).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining("Phase timed out") });
    expect(c.closed()).toBe(true);
  });
});

test("an optional diagnostic at work expiry cannot steal close reserve or change successful retirement", async () => {
  await control("diagnostic", async c => {
    // Let retirement settle before holding the optional terminal request.
    await c.evaluate("retirement.resolve(); shellRetirement.resolve(); void 0");
    await c.entered;
    c.expire();
    let finished = false;
    void c.result.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    c.releaseClose();
    expect((await c.result).status).toBe("pass");
    expect(c.closed()).toBe(true);
  }, cases[0]!, true);
});

type CloseScenario = "delayed" | "rejected" | "expired" | "cancelled" | "late-success" | "late-error";

async function closeControl(scenario: CloseScenario, stopFails = false) {
  const framework = frameworks[0]!;
  let now = Date.now(), cleaning = false, finished = false, settled = false;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const open = Scope.open;
  let cleanupScope: Scope | undefined;
  const scopes = spyOn(Scope, "open").mockImplementation((timeoutMs, parent) => {
    const scope = open(timeoutMs, parent);
    if (timeoutMs === 60_000 && !parent) cleanupScope = scope;
    return scope;
  });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const budgets: number[] = [], interrupts: (boolean | undefined)[] = [];
  let closing: Promise<void> | undefined;
  async function run(transport: Transport) {
    transport.capabilities.browserName = "firefox";
    const evaluate = transport.evaluate.bind(transport), close = transport.close.bind(transport);
    transport.beginCleanup = () => { cleaning = true; now += 1200; };
    transport.evaluate = <T>(expression: string, admission: Admission) => {
      if (cleaning && stopFails && expression.includes("function stopState")) return Promise.reject(new Error("original stop failure"));
      return evaluate<T>(expression, admission);
    };
    transport.close = (interrupt, timeoutMs) => {
      if (closing) return closing;
      interrupts.push(interrupt);
      budgets.push(timeoutMs ?? 0);
      entered.resolve();
      return closing = release.promise.then(async () => {
        await close();
        settled = true;
        if (scenario === "rejected" || scenario === "late-error") throw new Error("browser close rejected");
      });
    };
    const result = execute({ framework, box: { framework: framework.id, browser: "firefox", engine: "browser" },
      url: "http://fixture/?engine=browser", timeoutMs: 2000, createTransport: async () => transport,
      async saveLog() {
        now += 300;
        if (scenario === "expired" && cleanupScope) now = cleanupScope.deadline;
        if (scenario === "cancelled") cleanupScope?.close(new Error("cleanup cancelled"));
      },
    }).then(value => { finished = true; return value; });
    try {
      await entered.promise;
      if (scenario === "late-success" || scenario === "late-error") cleanupScope?.close(cleanupScope.expiryReason);
      else if (scenario !== "expired" && scenario !== "cancelled") {
        now += 13_196;
        await Promise.resolve();
        expect(finished).toBe(false);
      }
      release.resolve();
      const cell = await result;
      await closing?.catch(() => {});
      return { cell, budgets, interrupts, settled };
    } finally {
      release.resolve();
      await Promise.allSettled([result, closing]);
      transport.close = close;
    }
  }
  try { return await withPlayground(framework, 0, run); }
  finally { scopes.mockRestore(); clock.mockRestore(); }
}

test("browser close waits for actual settlement beyond the old cutoff using the remaining cleanup allowance", async () => {
  const result = await closeControl("delayed");
  expect(result.budgets).toEqual([58_500]);
  expect(result.interrupts).toEqual([true]);
  expect(result.settled).toBe(true);
  expect(result.cell).toMatchObject({ status: "pass" });
});

test.each([false, true])("browser close rejection remains a failure with prior stop failure=%s", async stopFails => {
  const result = await closeControl("rejected", stopFails);
  expect(result.settled).toBe(true);
  if (result.cell.status !== "fail") throw new Error("Browser close rejection must fail cleanup");
  expect(result.cell.phase).toBe("cleanup");
  expect(result.cell.error).toContain("browser close rejected");
  if (stopFails) expect(result.cell.error).toContain("original stop failure");
});

test.each(["expired", "cancelled"] as const)("%s cleanup still dispatches forced close and cannot pass", async scenario => {
  const result = await closeControl(scenario);
  expect(result.interrupts).toEqual([true]);
  expect(result.budgets).toEqual([scenario === "expired" ? 1 : 58_500]);
  expect(result.settled).toBe(true);
  expect(result.cell).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining(scenario === "expired" ? "Phase timed out after 60000 ms" : "cleanup cancelled") });
});

test.each(["late-success", "late-error"] as const)("browser close consumes %s after cleanup expiry without passing", async scenario => {
  const result = await closeControl(scenario);
  expect(result.settled).toBe(true);
  expect(result.cell).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining("Phase timed out after 60000 ms") });
});
