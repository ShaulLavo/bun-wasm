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
