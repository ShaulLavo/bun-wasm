import { expect, test } from "bun:test";
import { ProcessError } from "waffle/proc/types";
import { drainDiagnostic, DIAGNOSTIC_STALL_TIMEOUT_MS } from "waffle/browser/diagnostic";
import { emitTiming } from "../../scripts/timing-observation.ts";

for (const asynchronous of [false, true]) for (const error of [new Error("writer defect"), new ProcessError(8, "closed fd"), Object.assign(new Error("closed pipe"), { code: "EPIPE" })]) {
  test(`startup writer exceptions retain a typed unwritten count (${asynchronous}, ${error.message})`, async () => {
    let calls = 0, failure: unknown;
    try {
      await drainDiagnostic(new Uint8Array(10), () => {
        calls++;
        if (asynchronous && calls === 1) return -6;
        if (calls === (asynchronous ? 2 : 1)) return 3;
        throw error;
      }, () => true);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ProcessError);
    expect((failure as ProcessError).errno).toBe(29);
    expect(String(failure)).toContain("7 of 10 diagnostic bytes unwritten");
    expect(String(failure)).toContain(error.message);
  });
}

test("startup diagnostic writer progresses after a queued controller turn", async () => {
  const start = performance.now();
  const bytes = new Uint8Array([10, 20, 30]);
  let writable = false;
  const written: number[] = [];
  let blockedCalls = 0;
  const pending = drainDiagnostic(bytes, chunk => {
    if (!writable) { blockedCalls++; return -6; }
    written.push(...chunk);
    return chunk.length;
  }, () => true);
  expect(pending).toBeInstanceOf(Promise);
  expect(blockedCalls).toBeGreaterThan(0);
  expect(written).toEqual([]);
  await new Promise<void>(resolve => setImmediate(() => { writable = true; resolve(); }));
  await pending;
  expect(written).toEqual(Array.from(bytes));
  emitTiming("diagnostic-controller-progress", performance.now() - start);
}, 15_000);

test("startup diagnostic stalls retain the exact typed unwritten error", async () => {
  const pending = drainDiagnostic(new Uint8Array(3), () => -6, () => true);
  await expect(pending).rejects.toBeInstanceOf(ProcessError);
  await expect(pending).rejects.toMatchObject({ errno: 6, message: "diagnostic reader made no progress for five seconds; 3 of 3 diagnostic bytes unwritten" });
}, DIAGNOSTIC_STALL_TIMEOUT_MS + 10_000);
