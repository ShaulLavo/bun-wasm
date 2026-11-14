import { expect, test } from "bun:test";
import { launchFailureFixture } from "./fixtures/launch-failure.ts";
import { beginMemorySnapshot, endMemorySnapshot, recordLaunchFailure, retainedMemorySnapshots } from "../web/src/memory-telemetry.ts";
import { withPlayground } from "./goals-matrix/test-fixture.ts";
import { withScoped } from "./goals-matrix/scope-fixture.ts";
import { frameworks } from "./goals-matrix/catalog.ts";
import { execute } from "./goals-matrix/execute.ts";
import { diagnosticFilesystem, diagnosticPath } from "./goals-matrix/angular-diagnostic-fixture.ts";
import type { Transport } from "./goals-matrix/transport.ts";
import { ENGINES } from "../web/src/engine-loader.ts";
import type { Engine } from "../src/engine-kind.ts";
import { runInNewContext } from "node:vm";
import { launchFailureLog } from "./goals-matrix/browser-memory";

test("a missing retained hook is unavailable rather than an observed empty result", async () => {
  const transport = (context: object) => ({ async useHost() {}, async evaluate<T>(expression: string): Promise<T> { return runInNewContext(expression, context); } });
  const missing = await launchFailureLog(transport({}), "quickjs");
  const empty = await launchFailureLog(transport({ __bunRetainedMemorySnapshots: () => [] }), "quickjs");
  expect(missing).toContain("unavailable");
  expect(empty).toBe("");
  expect(missing).not.toBe(empty);
});

for (const engine of ["quickjs", "jsc", "browser"] as const) for (const owned of [false, true]) {
  test(`${engine} launcher facts and Angular log are saved before ${owned ? "owned" : "ordinary"} page disposal`, async () => {
    const framework = frameworks.find(value => value.id === "angular");
    if (!framework) throw Error("Missing Angular fixture");
    const filesystem = diagnosticFilesystem({ contents: "original Angular error detail" });
    const id = crypto.randomUUID();
    beginMemorySnapshot(engine, id, "launch-refusal-command");
    recordLaunchFailure(id, launchFailureFixture().capture());
    endMemorySnapshot(id);
    const snapshots = retainedMemorySnapshots().filter(value => value.id === id);
    try {
      await withPlayground(framework, 0, async transport => {
        await configure(transport, engine, snapshots);
        let closed = false;
        const logs: string[] = [];
        const close = transport.close;
        transport.close = async () => { closed = true; await close(); };
        if (owned) transport.cleanup = async () => { closed = true; return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
        const result = await execute({ framework, box: { framework: "angular", browser: "chrome", engine }, url: `http://fixture/?engine=${engine}`, timeoutMs: 1000, startupTimeoutMs: 1000,
          async createTransport() { return transport; }, async saveLog(text) { expect(closed).toBe(false); logs.push(text); },
        });
        expect(result).toMatchObject({ status: "fail", phase: "install" });
        expect(closed).toBe(true);
        expect(logs.join("\n")).toContain('"message":"original native refusal"');
        expect(logs.join("\n")).toContain('"commandId":"launch-refusal-command"');
        expect(logs.join("\n")).toContain("original Angular error detail");
        expect(logs.join("\n")).toContain('"terminal":true');
      }, 0, filesystem.filesystem);
    } finally { await filesystem.close(); }
  });
}

async function configure(transport: Transport, engine: Engine, snapshots: unknown): Promise<void> {
  await withScoped(transport, page => page.evaluate(`
    const query = document.querySelector;
    document.querySelector = selector => selector === '#engine' ? { value: ${JSON.stringify(engine)} } : selector === '#status' ? { textContent: ${JSON.stringify(`${ENGINES[engine].name} ready`)} } : query(selector);
    globalThis.__bunRetainedMemorySnapshots = () => ${JSON.stringify(snapshots)};
    globalThis.__bunMemorySnapshots = () => { throw Error('active worker diagnostics must not be needed for retained launcher facts'); };
    playground.term.buffer.active = { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => ${JSON.stringify(`Error: original launch failure\nSee "${diagnosticPath}" for further details.`)} }) };
    playground.shell.submit = async () => { throw Error('original launch failure'); };
  `));
}

test("a stalled Browser trap read cannot erase already copied launch facts or terminal output", () => stalledTrapCapture(true, true), 10_000);

for (const owned of [false, true]) test(`final-only launch facts survive stalled trap polling with owned cleanup ${owned}`, () => stalledTrapCapture(owned, false), 10_000);

async function stalledTrapCapture(owned: boolean, failureTimeObserved: boolean): Promise<void> {
  const framework = frameworks[0];
  if (!framework) throw Error("Missing framework fixture");
  await withPlayground(framework, 0, async transport => {
    await configure(transport, "browser", [{ engine: "browser", launchFailures: [launchFailureFixture().capture()] }]);
    const diagnostic = Promise.withResolvers<string>();
    const evaluate = transport.evaluate.bind(transport);
    let terminalReads = 0;
    transport.evaluate = (expression, admission, options) => {
      if (expression.includes("transcript") && ++terminalReads === 2 && !failureTimeObserved) return Promise.reject(Error("failure-time terminal unavailable"));
      if (expression.includes("browserTrapFacts")) return diagnostic.promise.then(() => evaluate(expression, admission, options));
      return evaluate(expression, admission, options);
    };
    let saved = "";
    let closed = false;
    const close = transport.close.bind(transport);
    transport.close = async () => { closed = true; await close(); };
    if (owned) transport.cleanup = async () => { closed = true; return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    try {
      const result = await execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" }, url: "http://fixture/?engine=browser", timeoutMs: 1000, startupTimeoutMs: 1000,
        async createTransport() { return transport; }, async saveLog(text) { saved = text; },
      });
      expect(result).toMatchObject({ status: "fail", phase: "install" });
      expect(closed).toBe(true);
      expect(saved).toContain("original launch failure");
      expect(saved).toContain("original native refusal");
    } finally { diagnostic.resolve("late diagnostic"); }
  });
}
