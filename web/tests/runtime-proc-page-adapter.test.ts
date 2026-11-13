import { expect, test } from "bun:test";
import ts from "typescript-api";
import { ownedDatabase } from "waffle/testing/page-runner";
import { automaticChecks } from "../../scripts/test-checks";
import { runtimeProcAdapter } from "./runtime-proc-ios-adapter";
import { runtimeProcFilesystemName, runtimeProcIds, runtimeProcLimits, runtimeProcRows } from "./runtime-proc-page-contract";
import { createRuntimeProcPageSuite } from "./runtime-proc-page-suite";
import { checkRuntimeProcResult } from "./runtime-proc-result";
import { runtimeProcChecks, runtimeProcJobWaitChecks } from "./runtime-proc-fixtures";

const source = await Bun.file(new URL("./runtime-proc-case-runner.ts", import.meta.url)).text();
const entry = await Bun.file(new URL("./runtime-proc-browser-main.ts", import.meta.url)).text();
const host = await Bun.file(new URL("./browser-runtime-proc.ts", import.meta.url)).text();
const ast = ts.createSourceFile("runtime-proc-case-runner.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const envelope = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "runRuntimeProcCase");
if (!envelope || !ts.isFunctionDeclaration(envelope) || !envelope.body) throw new Error("runtime-proc envelope missing");
const originalTry = envelope.body.statements.find(ts.isTryStatement);
if (!originalTry?.finallyBlock) throw new Error("runtime-proc finalizer missing");
const finalizer = originalTry.finallyBlock.getText(ast);

function success(scenario = "pipes") {
  return { ok: true, checks: Array.from<string>(scenario === "pipes" ? runtimeProcChecks : runtimeProcJobWaitChecks), stopCodes: scenario === "pipes" ? [130, 137] : [], admissionReports: 0, cleanup: { activeWorkers: 0 }, teardown: { forcedWorkers: 0, activeWorkers: 0 } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function originalFinalizer(dispose: () => Promise<void>, provisional = success()) {
  const localGlobal: Record<string, unknown> = { Worker: "tracked Worker" };
  const events: string[] = [];
  const activeWorkers = new Set([{ terminate() { events.push("terminate"); activeWorkers.delete(this); } }]);
  const options = { clearInterval() {}, heartbeat: 0, run: undefined, settled: true, runtime: { dispose }, activeWorkers,
    bootstrapURLs: new Set(["blob:owned"]), URL: { revokeObjectURL(url: string) { events.push(url); } }, globalThis: localGlobal,
    NativeWorker: "native Worker", result: provisional, admissionReports: 3 };
  const js = ts.transpileModule(`async function execute(options) { let { ${Object.keys(options).join(", ")} } = options; try {} finally ${finalizer} return globalThis.runtimeProcResult; }`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const execute = new Function("options", `${js}; return execute(options);`);
  const completion: Promise<unknown> = execute(options);
  return { completion, localGlobal, events };
}

for (const row of runtimeProcRows) {
  test(`the shared host oracle requires every original ${row.scenario}/${row.mode} assertion`, () => {
    const valid = success(row.scenario);
    const check = (result: unknown, errors: unknown = []) => checkRuntimeProcResult(result, row.scenario, errors);
    expect(() => check(valid)).not.toThrow();
    const reversed = valid.checks.slice(); reversed.reverse();
    for (const checks of [valid.checks.slice(1), valid.checks.concat(["extra"]), reversed, valid.checks.map(() => valid.checks[0]), "12", null]) {
      expect(() => check({ ...valid, checks })).toThrow();
    }
    for (const result of [undefined, null, {}, { ...valid, ok: false }, { ...valid, ok: 1 }, { ...valid, stopCodes: [0] }, { ...valid, cleanup: { activeWorkers: 1 } }, { ...valid, teardown: { forcedWorkers: 1, activeWorkers: 0 } }, { ...valid, teardown: { forcedWorkers: 0, activeWorkers: 1 } }]) expect(() => check(result)).toThrow();
    for (const errors of [undefined, null, ["page error"], ["console error"]]) expect(() => checkRuntimeProcResult(valid, row.scenario, errors)).toThrow();
    const id = `runtime-proc: ${row.scenario}/${row.mode}`;
    expect(() => runtimeProcAdapter.policy.check(id, { result: valid, errors: [] })).not.toThrow();
    expect(() => runtimeProcAdapter.policy.check(id, { result: valid })).toThrow();
    expect(() => runtimeProcAdapter.policy.check(id, { result: valid, errors: ["actual failure"] })).toThrow();
  });
}

test("the four ordered rows and original query flags remain complete", () => {
  const inventory = runtimeProcAdapter.inventory();
  expect(inventory.map(row => row.id)).toEqual(["runtime-proc: pipes/automatic", "runtime-proc: pipes/explicit", "runtime-proc: job-wait/automatic", "runtime-proc: job-wait/explicit"]);
  expect(inventory.map(row => row.query?.("run"))).toEqual([{ slots: "off" }, { slots: "off", explicit: "1" }, { slots: "off", "job-wait": "1" }, { slots: "off", explicit: "1", "job-wait": "1" }]);
  expect(runtimeProcAdapter.policy.listIds({ ids: runtimeProcIds })).toEqual(runtimeProcIds);
  expect(() => runtimeProcAdapter.policy.listIds({ ids: runtimeProcIds.slice(1) })).toThrow();
  expect(() => runtimeProcAdapter.policy.check("unknown", { result: success(), errors: [] })).toThrow();
  expect(runtimeProcAdapter.policy.requireResult).toBe(true);
  expect(inventory.map(row => row.console)).toEqual(Array.from({ length: 4 }, () => "fail-on-error"));
});

test("allocation ACK precedes invoking or importing the original runner", async () => {
  const ack = deferred();
  const calls: string[] = [];
  const suite = createRuntimeProcPageSuite(async name => { calls.push(name); return success(); });
  expect(await suite.list()).toEqual({ ids: runtimeProcIds });
  expect(await suite.finish([])).toEqual([]);
  const pending = suite.run({ databaseName: "bun-runtime-proc-run" }, () => ack.promise);
  await Promise.resolve();
  expect(calls).toEqual([]);
  ack.resolve();
  expect(await pending).toEqual({ result: success(), errors: [] });
  expect(calls).toEqual(["bun-runtime-proc-run"]);
  expect(entry.indexOf('await import("./runtime-proc-case-runner")')).toBeGreaterThan(entry.indexOf("async name =>"));
});

test("rejected allocation never enters the fixture", async () => {
  let calls = 0;
  const suite = createRuntimeProcPageSuite(async () => { calls++; });
  await expect(suite.run({ databaseName: "foreign" }, async () => { throw Error("allocation rejected"); })).rejects.toThrow("allocation rejected");
  expect(calls).toBe(0);
});

test("only the exact run database is owned, and finish uses the shared ledger cleanup", () => {
  const run = "unit-run";
  const name = runtimeProcFilesystemName(run);
  expect(name).toBe(`bun-runtime-proc-${run}`);
  expect(runtimeProcAdapter.inventory().map(row => row.request(run))).toEqual(Array.from({ length: 4 }, () => ({ databaseName: name })));
  const policy = ownedDatabase("bun-runtime-proc");
  expect(() => policy({ kind: "indexeddb", name }, runtimeProcIds, run)).not.toThrow();
  for (const foreign of ["waffle-workspace", name + "-1", runtimeProcFilesystemName("another")]) expect(() => policy({ kind: "indexeddb", name: foreign }, runtimeProcIds, run)).toThrow();
  expect(() => policy({ kind: "opfs-directory", name }, runtimeProcIds, run)).toThrow();
  expect(() => policy({ kind: "indexeddb", name }, [], run)).toThrow();
});

test("the actual original finalizer gates observation, restores Worker and revokes owned URLs", async () => {
  const disposal = deferred();
  const errors: string[] = [];
  const fixture = originalFinalizer(() => disposal.promise);
  const suite = createRuntimeProcPageSuite(() => fixture.completion, errors);
  let observed = false;
  const result = suite.run({ databaseName: "owned" }, async () => {}).then(value => { observed = true; return value; });
  await Promise.resolve();
  expect(observed).toBe(false);
  expect(fixture.localGlobal.Worker).toBe("tracked Worker");
  errors.push("late page error during disposal");
  disposal.resolve();
  expect(await result).toMatchObject({ result: { teardown: { forcedWorkers: 1, activeWorkers: 0 } }, errors });
  expect(fixture.events).toEqual(["terminate", "blob:owned"]);
  expect(fixture.localGlobal.Worker).toBe("native Worker");
  expect(() => checkRuntimeProcResult(fixture.localGlobal.runtimeProcResult, "pipes", [])).toThrow();
});

test("original cleanup failure replaces provisional success before transport", async () => {
  const fixture = originalFinalizer(async () => { throw Error("dispose failed"); });
  expect(await fixture.completion).toMatchObject({ ok: false, teardownError: "Error: dispose failed", teardown: { error: "Error: dispose failed" } });
  expect(fixture.localGlobal.Worker).toBe("native Worker");
});

test("rejected fixture completion propagates without manufacturing a result", async () => {
  const suite = createRuntimeProcPageSuite(async () => { throw Error("import or finalizer rejected"); });
  await expect(suite.run({ databaseName: "owned" }, async () => {})).rejects.toThrow("import or finalizer rejected");
});

test("one original absolute 160-second command clock covers setup and all four rows", () => {
  expect(runtimeProcAdapter.budgets(4)).toEqual({ hello: 20_000, heartbeat: 10_000, case: 40_000, group: 160_000, run: 160_000 });
  expect(runtimeProcAdapter.resultWaitMs).toBe(40_000);
  expect(runtimeProcLimits.pageMs).toBe(20_000);
  expect(host).toContain("Math.max(120_000, names.length * iterations * modes.length * scenarios.length * 40_000)");
  expect(host.indexOf("const deadline =")).toBeLessThan(host.indexOf('await processBundle("runtime-proc", out)'));
  expect(host).toContain("timeout: 40_000");
  expect(source).toContain('operations=${messages.join(",")}`)), 20_000)');
  expect(host.indexOf('if (process.argv[2] === "ios-safari")')).toBeLessThan(host.indexOf('await import("playwright")'));
  expect(host.indexOf("const startedAt = performance.now()")).toBeLessThan(host.indexOf('await import("waffle/testing/page-runner")'));
  expect(host).toContain("checkRuntimeProcResult(completed, scenario, errors)");
  expect(automaticChecks()).toContainEqual({ owner: "web", path: "web/tests/runtime-proc-page-adapter.test.ts" });
});

function preservedSource(): string {
  const normalized = source.replace("...(databaseName ? { name: databaseName } : {}), ", "");
  const tree = ts.createSourceFile("fixture.ts", normalized, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = tree.statements.flatMap(statement => {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== "runRuntimeProcCase" || !statement.body) return [statement];
    return Array.from(statement.body.statements).filter(statement => !ts.isReturnStatement(statement));
  });
  const printer = ts.createPrinter({ removeComments: false });
  return statements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, tree)).join("\n");
}

test("the complete original fixture, diagnostics, guest assertions and finalizer are frozen", () => {
  // Printer hash of browser-runtime-proc-main.ts at 2609b9d39e8548751f5895a191c28458bf4df942.
  expect(new Bun.CryptoHasher("sha256").update(preservedSource()).digest("hex")).toBe("b709fe7a44f65fba661b7b9c9d64ef15c92d2cf138a4d4373e03b25e4eee9dc7");
});
