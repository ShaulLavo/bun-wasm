import { expect, test } from "bun:test";
import ts from "typescript-api";
import {
  checkProcessResult,
  processResultForTransport,
  evaluateProcessObservation,
  processCheckLabels,
  processCommandLimits,
  processFilesystemName,
  type ProcessObservation,
} from "./process-page-adapter";
import { createProcessPageSuite } from "./process-page-suite";
import { processAdapter } from "./process-ios-adapter";
import { ownedDatabase } from "waffle/testing/page-runner";
import { automaticChecks } from "../../scripts/test-checks";

const pageSource = await Bun.file(new URL("./process-browser-main.ts", import.meta.url)).text();
const runnerSource = await Bun.file(new URL("./browser-process.ts", import.meta.url)).text();
const pageAST = ts.createSourceFile("process-browser-main.ts", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const envelope = pageAST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "runProcessCases");
const pageTry = envelope && ts.isFunctionDeclaration(envelope) ? envelope.body?.statements.find(ts.isTryStatement) : undefined;
if (!pageTry?.finallyBlock) throw new Error("original process command finally missing");
const commandFinalizer = pageTry.finallyBlock;
const finallySource = commandFinalizer.getText(pageAST);

function success(): ProcessObservation {
  return { result: { ok: true, checks: processCheckLabels.slice(), errors: [], cleanup: { activeWorkers: 0 } }, progress: { currentTest: processCheckLabels.at(-1) }, pageErrors: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

// Execute the original finally unchanged, with only its runtime and Worker consumers isolated.
function runOriginalFinally(options: { observation: ProcessObservation; dispose: () => Promise<void>; events: string[] }) {
  const localGlobal = { processResult: options.observation.result, Worker: "tracked Worker" };
  const checks = processCheckLabels.slice();
  const activeWorkers = new Set([{ terminate() { options.events.push("terminate"); } }]);
  const execute = new Function("activeRuntime", "activeWorkers", "NativeWorker", "checks", "globalThis",
    `return (async () => { try {} finally ${finallySource} })();`);
  const completion: Promise<unknown> = execute({ dispose: options.dispose }, activeWorkers, "original Worker", checks, localGlobal);
  return { completion, localGlobal, observe: () => ({ ...options.observation, result: localGlobal.processResult }) };
}

async function runFinalizerControl(options: { completion: Promise<unknown>; observe: () => ProcessObservation }, errors: readonly string[] = []) {
  const suite = createProcessPageSuite(async () => { await options.completion; return options.observe(); }, errors);
  const result = await suite.run({ databaseName: processFilesystemName("unit-run") }, async () => {});
  return evaluateProcessObservation({ result, progress: undefined, pageErrors: errors });
}

function isRegistration(statement: ts.Statement): boolean {
  if (ts.isForOfStatement(statement)) return true;
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false;
  const expression = statement.expression.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "test";
}

test("all 23 original registrations produce the exact ordered labels without running their bodies", async () => {
  const statements = pageTry.tryBlock.statements.filter(isRegistration);
  const source = statements.map(statement => statement.getText(pageAST)).join("\n");
  const body = ts.transpileModule(`async function collect(test) { ${source} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const collect = new Function("test", `${body}; return collect(test);`);
  const labels: string[] = [];
  await collect(async (label: string) => { labels.push(label); });
  expect(labels).toHaveLength(23);
  expect<readonly string[]>(labels).toEqual(processCheckLabels);
});

test("only an exact successful result can pass", () => {
  for (const result of [undefined, null, [], {}, { ok: false, checks: processCheckLabels }, { ok: 1, checks: processCheckLabels }]) {
    expect(evaluateProcessObservation({ ...success(), result }).status).toBe("fail");
  }
  expect(evaluateProcessObservation(success()).status).toBe("pass");
});

test("count alone cannot pass duplicate, substituted, reordered, partial or extra checks", () => {
  const swapped = processCheckLabels.slice();
  swapped.reverse();
  const wrong = [
    Array.from({ length: 23 }, () => processCheckLabels[0]),
    processCheckLabels.slice(0, 22).concat(["substituted label"]),
    swapped,
    processCheckLabels.slice(0, 22),
    processCheckLabels.concat(["artifact must not count"]),
    Array(23),
    "23",
    null,
  ];
  for (const checks of wrong) {
    const evaluation = evaluateProcessObservation({ ...success(), result: { ok: true, checks } });
    expect(evaluation.status).toBe("fail");
  }
});

test("an early failure retains partial checks and currentTest and leaves successors not-run", () => {
  const checks = processCheckLabels.slice(0, 2);
  const currentTest = "cpu-default-signal-15-status-143";
  const result = { ok: false, checks, error: "assertion failed" };
  const evaluation = evaluateProcessObservation({ result, progress: { checks, currentTest }, pageErrors: [] });
  expect(evaluation.checks).toEqual(checks);
  expect(evaluation.currentTest).toBe(currentTest);
  expect(evaluation.result).toEqual(result);
  expect<readonly string[]>(evaluation.cases.map(entry => entry.status)).toEqual(["pass", "pass", "fail"].concat(Array.from({ length: 20 }, () => "not-run")));
});

test("missing results retain diagnostic progress but cannot pass", () => {
  const checks = processCheckLabels.slice(0, 1);
  const evaluation = evaluateProcessObservation({ result: undefined, progress: { checks, currentTest: "startup" }, pageErrors: [] });
  expect(evaluation.status).toBe("fail");
  expect(evaluation.checks).toEqual(checks);
  expect(evaluation.cases.filter(entry => entry.status === "pass")).toHaveLength(1);
});

test("out-of-order checks never turn later successors into passes", () => {
  const evaluation = evaluateProcessObservation({ ...success(), result: { ok: false, checks: [processCheckLabels[0], processCheckLabels[4]] } });
  expect(evaluation.cases.filter(entry => entry.status === "pass")).toHaveLength(1);
  expect(evaluation.cases[4]?.status).toBe("not-run");
});

test("pageerror messages stay distinct from transport and cleanup errors", () => {
  const pageErrors = ["page fault"];
  const evaluation = evaluateProcessObservation({ ...success(), result: { ok: true, checks: processCheckLabels, errors: pageErrors } });
  pageErrors.push("later observation");
  expect(evaluation.status).toBe("fail");
  expect(evaluation.pageErrors).toEqual(["page fault"]);
  expect(evaluation.issues).toEqual(["pageerror.message array must deep-equal []"]);
  expect(evaluateProcessObservation({ ...success(), result: { ok: true, checks: processCheckLabels } }).status).toBe("fail");
});

test("the actual original deferred finalizer blocks observation and restores Workers before observation", async () => {
  const disposed = deferred<void>();
  const entered = deferred<void>();
  const events: string[] = [];
  const fixture = runOriginalFinally({ observation: success(), events, async dispose() { entered.resolve(); await disposed.promise; events.push("dispose"); } });
  const result = runFinalizerControl({ completion: fixture.completion, observe() { events.push("observe"); expect(fixture.localGlobal.Worker).toBe("original Worker"); return fixture.observe(); } });
  await entered.promise;
  await Promise.resolve();
  expect(events).toEqual([]);
  disposed.resolve();
  expect((await result).status).toBe("pass");
  expect(events).toEqual(["dispose", "terminate", "observe"]);
});

test("the actual original finally replaces provisional success on cleanup failure", async () => {
  const fixture = runOriginalFinally({ observation: success(), events: [], async dispose() { throw new Error("runtime disposal failed"); } });
  const evaluation = await runFinalizerControl(fixture);
  expect(evaluation.status).toBe("fail");
  expect(evaluation.result).toMatchObject({ ok: false, cleanupError: "Error: runtime disposal failed" });
  expect(evaluation.cases.every(entry => entry.status === "pass")).toBe(true);
  expect(fixture.localGlobal.Worker).toBe("original Worker");
});

test("an error after provisional success survives until the original finally settles", async () => {
  const disposed = deferred<void>();
  const entered = deferred<void>();
  const pageErrors: string[] = [];
  const fixture = runOriginalFinally({ observation: { ...success(), pageErrors }, events: [], async dispose() { entered.resolve(); await disposed.promise; } });
  const evaluation = runFinalizerControl(fixture, pageErrors);
  await entered.promise;
  pageErrors.push("late pageerror.message");
  disposed.resolve();
  expect((await evaluation).pageErrors).toEqual(["late pageerror.message"]);
  expect((await evaluation).status).toBe("fail");
});

test("a rejected completion propagates to the shared-host seam without inventing page errors", async () => {
  const failure = new Error("host import or finalization failed");
  let observed = false;
  await expect(runFinalizerControl({ completion: Promise.reject(failure), observe() { observed = true; return success(); } })).rejects.toBe(failure);
  expect(observed).toBe(false);
});

const run = "run_0123456789abcdef";

test("the unchanged original command arms its deadline before port probing and bundling", () => {
  expect(runnerSource).toContain("benchmark ? 360_000 : 120_000");
  expect(runnerSource.indexOf("const deadline =")).toBeLessThan(runnerSource.indexOf("await freePort();"));
  expect(runnerSource.indexOf("await freePort();")).toBeLessThan(runnerSource.indexOf('await processBundle("supervisor", out)'));
  expect(runnerSource).toContain("timeout: 90_000");
  expect(pageSource).toContain("const end = performance.now() + 10_000;");
  expect(runnerSource).toContain('page.on("pageerror", error => errors.push(error.message))');
  expect(runnerSource).toContain("assert.deepEqual(errors, [])");
});

test("the focused test retains the existing automatic Web check owner without a second manifest", () => {
  expect(automaticChecks()).toContainEqual({ owner: "web", path: "web/tests/process-page-adapter.test.ts" });
});

test("the approved ownedDatabase name is exactly bun-process followed by the run", () => {
  expect(processFilesystemName(run)).toBe(`bun-process-${run}`);
});

test("transported results require their own actual errors array", () => {
  for (const errors of [undefined, null, {}, "", ["page fault"]]) {
    const result = { ok: true, checks: processCheckLabels, errors };
    expect(evaluateProcessObservation({ ...success(), result }).status).toBe("fail");
    expect(() => checkProcessResult(result)).toThrow("pageerror.message array");
  }
  expect(() => checkProcessResult(success().result)).not.toThrow();
});

test("missing required result is protocol failure while present null is a test failure", () => {
  expect(evaluateProcessObservation({ ...success(), result: undefined })).toMatchObject({ status: "fail", failure: "protocol" });
  expect(evaluateProcessObservation({ ...success(), result: null })).toMatchObject({ status: "fail", failure: "test" });
});

test("transport carries only actual observed pageerror messages and preserves partial failure evidence", () => {
  const pageErrors = ["observed pageerror.message"];
  const checks = processCheckLabels.slice(0, 2);
  const progress = { checks, currentTest: "cpu-default-signal-15-status-143" };
  const result = processResultForTransport({ result: { ok: false, checks, error: "assertion" }, progress, pageErrors });
  pageErrors.push("later page error");
  expect(result).toEqual({ ok: false, checks, error: "assertion", currentTest: progress.currentTest, errors: ["observed pageerror.message"] });
  expect(processResultForTransport({ result: undefined, progress, pageErrors })).toBeUndefined();
  expect(() => checkProcessResult(processResultForTransport({ ...success(), pageErrors: undefined }))).toThrow("pageerror.message array");
});

test("the actual shared allocation policy accepts only the exact running IndexedDB name", () => {
  const policy = ownedDatabase("bun-process");
  const name = processFilesystemName(run);
  expect(() => policy({ kind: "indexeddb", name }, ["bun-process: default"], run)).not.toThrow();
  expect(() => policy({ kind: "indexeddb", name }, [], run)).toThrow();
  expect(() => policy({ kind: "opfs-directory", name }, ["bun-process: default"], run)).toThrow();
  for (const foreign of ["waffle-workspace", name + "-1", name + "-128", `bun-wasm-process-${run}-workspace`, processFilesystemName("another-run")]) {
    expect(() => policy({ kind: "indexeddb", name: foreign }, ["bun-process: default"], run)).toThrow();
  }
});

test("the real page-suite waits for allocation ACK before invoking the body exactly once", async () => {
  const ack = deferred<void>();
  let calls = 0;
  const suite = createProcessPageSuite(async databaseName => { calls++; expect(databaseName).toBe(processFilesystemName(run)); return success(); }, []);
  expect(await suite.list()).toEqual({ ids: ["bun-process: default"] });
  expect(await suite.finish([])).toEqual([]);
  expect(calls).toBe(0);
  const result = suite.run({ databaseName: processFilesystemName(run) }, () => ack.promise);
  await Promise.resolve();
  expect(calls).toBe(0);
  ack.resolve();
  expect(evaluateProcessObservation({ result: await result, progress: undefined, pageErrors: [] }).status).toBe("pass");
  expect(calls).toBe(1);
});

test("rejected allocation cannot invoke the original command envelope", async () => {
  let calls = 0;
  const suite = createProcessPageSuite(async () => { calls++; return success(); }, []);
  await expect(suite.run({ databaseName: processFilesystemName(run) }, async () => { throw new Error("allocation rejected"); })).rejects.toThrow("allocation rejected");
  expect(calls).toBe(0);
});

test("the actual typed adapter requires results and retains the original command budgets", () => {
  expect(processAdapter.policy.requireResult).toBe(true);
  expect(processAdapter.resultWaitMs).toBe(90_000);
  expect(processAdapter.budgets(1)).toEqual({ hello: 20_000, heartbeat: 10_000, case: 120_000, group: 120_000, run: 120_000 });
  expect(processCommandLimits.pageWaitMs).toBe(10_000);
  expect(processAdapter.inventory()[0]?.request(run)).toEqual({ databaseName: `bun-process-${run}` });
});

test("native dispatch precedes desktop-only Playwright value imports and allocations", () => {
  const dispatch = runnerSource.indexOf('if (process.argv[2] === "ios-safari")');
  expect(dispatch).toBeGreaterThan(0);
  expect(dispatch).toBeLessThan(runnerSource.indexOf('await import("playwright")'));
  expect(dispatch).toBeLessThan(runnerSource.indexOf("await freePort()"));
  expect(runnerSource).not.toContain('import { chromium, firefox, webkit');
});

function originalBodyFingerprints() {
  const printer = ts.createPrinter({ removeComments: false });
  const callbacks: string[] = [], scopeFinalizers: string[] = [];
  function collect(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
      const callback = node.arguments[1];
      if (!callback || !ts.isArrowFunction(callback)) throw new Error("process case callback missing");
      callbacks.push(printer.printNode(ts.EmitHint.Unspecified, callback.body, pageAST));
    }
    if (ts.isTryStatement(node) && node.finallyBlock?.getText(pageAST).includes("await s.dispose()")) scopeFinalizers.push(printer.printNode(ts.EmitHint.Unspecified, node.finallyBlock, pageAST));
    ts.forEachChild(node, collect);
  }
  collect(pageAST);
  const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    callbacks: callbacks.length, callbackHash: digest(callbacks),
    scopeFinalizers: scopeFinalizers.length, scopeFinalizerHash: digest(scopeFinalizers),
    commandFinallyHash: digest(printer.printNode(ts.EmitHint.Unspecified, commandFinalizer, pageAST)),
  };
}

test("the original case bodies, assertions and awaited finalizers remain unchanged", () => {
  // TypeScript printer hashes from 3b46c7fb6cc4eef1fb5493d05ebf16a90473d396,
  // including optional artifact bodies. CI needs no historical Git objects.
  expect(originalBodyFingerprints()).toEqual({
    callbacks: 16, callbackHash: "3cc1fdae9d9e01a0d4b735f6aac694b6a5ae93de3025967330921ec0f345baec",
    scopeFinalizers: 17, scopeFinalizerHash: "ae3ab78b586f0d36ac1bdefad3d9cce789f421deb9da774a622f0c812ec664a7",
    commandFinallyHash: "0696b53c2746ea07ddba78ea7d30f4c24ad69b3bdc0b4e9999efc975e739dc07",
  });
});
