import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { automaticChecks } from "../../scripts/test-checks";
import { createProcessPageSuite } from "./process-page-suite";
import { processAdapter } from "./process-ios-adapter";
import { processDiagnosticAdapter, readProcessDiagnosticEnvelope, writeProcessDiagnostics } from "./process-diagnostic-adapter";
import { processCheckLabels, processCommandId } from "./process-page-adapter";

const success = { ok: true, checks: processCheckLabels.slice(), cleanup: { activeWorkers: 0 } };
const variants = [
  { label: "success", result: success, errors: [] },
  { label: "fourth-case assertion", result: { ok: false, checks: processCheckLabels.slice(0, 3), error: "Error: original fourth-case assertion", stack: "original stack" }, errors: [] },
  { label: "pageerror", result: success, errors: ["original pageerror.message"] },
];

function verdict(check: () => void): string | undefined {
  try { check(); }
  catch (error) { return String(error); }
}

for (const variant of variants) {
  test(`${variant.label} preserves original payload bytes and policy error`, async () => {
    const run = async () => ({ result: variant.result, progress: { currentTest: processCheckLabels[3] } });
    const request = { databaseName: "bun-process-unit" };
    const allocate = async () => {};
    const original = await createProcessPageSuite(run, variant.errors).run(request, allocate);
    const envelope = readProcessDiagnosticEnvelope(await createProcessPageSuite(run, variant.errors, () => ({ token: "same-document" })).run(request, allocate));
    expect(JSON.stringify(envelope.processResult)).toBe(JSON.stringify(original));
    expect(verdict(() => processDiagnosticAdapter(processAdapter).policy.check?.(processCommandId, envelope)))
      .toBe(verdict(() => processAdapter.policy.check?.(processCommandId, original)));
    expect(envelope.diagnostic).toEqual({ status: "captured", value: { token: "same-document" } });
  });
}

test("diagnostic waits for the original finalizer and leaves list and finish untouched", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const plain = createProcessPageSuite(async () => ({ result: success, progress: {} }), []);
  const suite = createProcessPageSuite(async () => {
    try { return { result: success, progress: {} }; }
    finally { await gate; events.push("finally"); }
  }, [], () => { events.push("diagnostic"); return null; });
  expect(await suite.list()).toEqual(await plain.list());
  expect(suite.finish).toBe(plain.finish);
  const pending = suite.run({ databaseName: "bun-process-unit" }, async () => { events.push("allocation ACK"); });
  await Promise.resolve();
  expect(events).toEqual(["allocation ACK"]);
  release();
  await pending;
  expect(events).toEqual(["allocation ACK", "finally", "diagnostic"]);
});

test("callback errors, non-JSON values and oversized diagnostics stay secondary", async () => {
  const callbacks = [() => { throw new Error("probe failed"); }, () => 1n, () => undefined, () => "x".repeat(20_000)];
  for (const diagnostic of callbacks) {
    const suite = createProcessPageSuite(async () => ({ result: success, progress: {} }), [], diagnostic);
    const envelope = readProcessDiagnosticEnvelope(await suite.run({ databaseName: "bun-process-unit" }, async () => {}));
    expect(envelope.diagnostic.status).toBe("error");
    expect(() => processDiagnosticAdapter(processAdapter).policy.check?.(processCommandId, envelope)).not.toThrow();
  }
});

test("allocation rejection and original rejection do not run diagnostics", async () => {
  let calls = 0;
  const suite = createProcessPageSuite(async () => { throw new Error("original failure"); }, [], () => { calls++; return null; });
  await expect(suite.run({ databaseName: "bun-process-unit" }, async () => {})).rejects.toThrow("original failure");
  await expect(suite.run({ databaseName: "bun-process-unit" }, async () => { throw new Error("allocation failure"); })).rejects.toThrow("allocation failure");
  expect(calls).toBe(0);
});

test("diagnostic adapter delegates the exact original check and preserves every other setting", () => {
  let received: unknown;
  const sentinel = new Error("primary policy error");
  const original = { ...processAdapter, policy: { ...processAdapter.policy, check(_id: string, value: unknown) { received = value; throw sentinel; } } };
  const adapter = processDiagnosticAdapter(original);
  const payload = { original: true };
  expect(() => adapter.policy.check?.(processCommandId, { kind: "bun-process-diagnostic", processResult: payload, diagnostic: { status: "error", error: "probe" } })).toThrow(sentinel);
  expect(received).toBe(payload);
  expect(adapter.inventory).toBe(original.inventory);
  expect(adapter.assets).toBe(original.assets);
  expect(adapter.page).toBe(original.page);
  expect(adapter.budgets).toBe(original.budgets);
  expect(adapter.resultWaitMs).toBe(original.resultWaitMs);
  expect(adapter.policy.allocation).toBe(original.policy.allocation);
  expect(adapter.policy.listIds).toBe(original.policy.listIds);
  expect(adapter.policy.requireResult).toBe(original.policy.requireResult);
});

test("secondary result writer preserves primary file on success and sink failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-diagnostic-"));
  try {
    const resultPath = join(root, "primary.json");
    const diagnosticPath = join(root, "diagnostic.json");
    const primary = JSON.stringify({ exit: 1, results: { [processCommandId]: { kind: "bun-process-diagnostic", processResult: { ok: false, error: "original" }, diagnostic: { status: "captured", value: { token: "same-document" } } } } });
    await Bun.write(resultPath, primary);
    expect(await writeProcessDiagnostics(resultPath, diagnosticPath)).toEqual({ status: "written", path: diagnosticPath });
    expect(await Bun.file(diagnosticPath).json()).toEqual({ status: "captured", value: { token: "same-document" } });
    expect(await writeProcessDiagnostics(resultPath, diagnosticPath, async () => { throw new Error("sink failed"); }))
      .toEqual({ status: "error", error: "Error: sink failed" });
    expect(await Bun.file(resultPath).text()).toBe(primary);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing original result stays missing instead of becoming an envelope", async () => {
  let calls = 0;
  const suite = createProcessPageSuite(async () => ({ result: undefined, progress: {} }), [], () => { calls++; return null; });
  expect(await suite.run({ databaseName: "bun-process-unit" }, async () => {})).toBeUndefined();
  expect(calls).toBe(0);
});

test("diagnostic controls keep the existing automatic Web owner", () => {
  expect(automaticChecks()).toContainEqual({ owner: "web", path: "web/tests/process-page-diagnostics.test.ts" });
});
