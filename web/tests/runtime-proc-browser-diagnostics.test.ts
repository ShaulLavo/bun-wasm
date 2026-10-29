import { expect, test } from "bun:test";
import { runtimeProcFailure } from "./runtime-proc-browser-diagnostics";

const payload = {
  admissions: [
    { sequence: 1, pid: 17, parentPid: 12, job: 3, directory: "opaque-dir", stage: "rejected", reason: "unknown-sender" },
    { sequence: 2, pid: 17, parentPid: 12, job: 3, directory: "opaque-dir", stage: "dropped", reason: "already-registered" },
  ],
  admissionReportsAtFailure: 1,
  admissionReports: 2,
  ioCalls: [{ worker: 2, operation: "read", fd: 4, result: -6 }, { worker: 2, operation: "poll", result: 1 }, { worker: 2, operation: "read", fd: 4, result: 0 }],
  ioReports: 3,
  spawns: [{ pid: 17, directory: "opaque-dir" }],
  terminalDiagnostics: {
    heartbeat: { intervalMs: 50, ticks: 100, maxGapMs: 57 },
    workers: [{ worker: 2, doorbellCount: 1, doorbellTimes: [21.5], header: [0, 0, 0, 0, 0, 0, 1, 0],
      abiReports: 1, abiCalls: [{ operation: "write", args: [11, 1024, 13], result: -6 }] }],
  },
};
const metadata = { browser: "webkit", mode: "automatic", scenario: "job-wait", pageErrors: ["page error"] };

test("published failure logs retain rejection/drop identities, boundary and read/poll trace", async () => {
  const output = await runtimeProcFailure(metadata, new Error("guest exit 105"), payload, async () => { throw new Error("must not replace published evidence"); });
  expect(JSON.parse(output)).toEqual({ ...metadata, ...payload, ok: false, assertionError: "Error: guest exit 105" });
  expect(output).toContain('\n  "admissions": [\n');
});

test("result-publication failure snapshots the live buffers before the page closes", async () => {
  let snapshots = 0;
  const output = await runtimeProcFailure(metadata, new Error("result timeout"), undefined, async () => { snapshots++; return payload; });
  expect(snapshots).toBe(1);
  expect(JSON.parse(output)).toEqual({ ...metadata, ...payload, ok: false, assertionError: "Error: result timeout" });
});

test("a crashed page still logs the original failure and snapshot error", async () => {
  const output = await runtimeProcFailure(metadata, new Error("page crashed"), undefined, async () => { throw new Error("page closed"); });
  expect(JSON.parse(output)).toEqual({ ...metadata, diagnosticsError: "Error: page closed", ok: false, assertionError: "Error: page crashed" });
});

test("a page that has not installed its diagnostics reports unavailable evidence", async () => {
  const output = await runtimeProcFailure(metadata, new Error("navigation failed"), undefined, async () => undefined);
  expect(JSON.parse(output)).toEqual({ ...metadata, diagnosticsError: "live diagnostics unavailable", ok: false, assertionError: "Error: navigation failed" });
});

test("an unresponsive page cannot hold diagnostic cleanup indefinitely", async () => {
  const output = await runtimeProcFailure(metadata, new Error("result timeout"), undefined, () => new Promise(() => {}));
  expect(JSON.parse(output)).toEqual({ ...metadata, diagnosticsError: "Error: live diagnostics snapshot timed out", ok: false, assertionError: "Error: result timeout" });
}, 4000);
