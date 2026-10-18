import { expect, test } from "bun:test";
import { ProcessError } from "waffle/proc/types";
import { drainDiagnostic, DIAGNOSTIC_STALL_TIMEOUT_MS } from "waffle/browser/diagnostic";

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

test("startup diagnostic stalls are bounded without blocking the controller", async () => {
  const start = performance.now();
  const pending = drainDiagnostic(new Uint8Array(3), () => -6, () => true);
  expect(pending).toBeInstanceOf(Promise);
  expect(performance.now() - start).toBeLessThan(100);
  await expect(pending).rejects.toMatchObject({ errno: 6, message: "diagnostic reader made no progress for five seconds; 3 of 3 diagnostic bytes unwritten" });
}, DIAGNOSTIC_STALL_TIMEOUT_MS + 2_000);
