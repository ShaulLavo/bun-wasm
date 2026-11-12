import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservation, finishObservation } from "./sharing-controls";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { observeProcess, parseTaskStat, schedstatsEnabled, summarizeTask } from "./observe-process";
import { launchProcess } from "./lifecycle-process";

test("proc stat parser retains start identity with spaces and parentheses", () => {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = "R"; fields[7] = "12"; fields[11] = "23"; fields[19] = "45";
  expect(parseTaskStat(`123 (a name (x)) ${fields.join(" ")}`)).toMatchObject({ name: "a name (x)", startTicks: 45, minorFaults: 12, userTicks: 23 });
  expect(() => parseTaskStat("not a proc record")).toThrow();
});

test("external observer measures an owned root and child without counting controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-observer-test-"));
  const code = "const stop=Date.now()+1500; while(Date.now()<stop) Math.sqrt(Math.random());";
  const command = [process.execPath, "-e", `const child=Bun.spawn([process.execPath,'-e',${JSON.stringify(code)}]); ${code} await child.exited; await Bun.sleep(1000);`];
  const job = launchProcess(command, root, process.env, root);
  let observer: Awaited<ReturnType<typeof observeProcess>> | undefined;
  try {
    expect(job.child.pid).toBeNumber();
    observer = await observeProcess(job.child.pid!, "test root and child", 100);
    await Bun.sleep(1800);
    const result = await observer.stop(); observer = undefined;
    expect(result.summary.observedCpuSeconds).toBeGreaterThan(0);
    expect(result.samples.some(sample => sample.processes.length > 1)).toBe(true);
    expect(result.samples.every(sample => sample.processes.every(row => !row.identity.available || row.identity.pid !== process.pid))).toBe(true);
    expect(result.summary.threads.every(row => row.endpoints.includes("not guaranteed"))).toBe(true);
  } finally { await observer?.stop(); await job.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);

test("missing observer root records unavailable without throwing into the workload", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-observer-missing-"));
  try {
    const started = await startObservation(undefined, "unavailable test scope");
    expect(started.observer).toBeNull();
    expect(await finishObservation(started, root + "/observation.json")).toMatchObject({ kind: "unavailable" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scheduler runtime alone does not establish enabled queue accounting", () => {
  expect(schedstatsEnabled([{ value: "0\n", error: null }, { value: "0\n", error: null }])).toBe(false);
  expect(schedstatsEnabled([{ value: "1\n", error: null }, { value: null, error: "missing" }])).toBe(false);
  expect(schedstatsEnabled([{ value: "1\n", error: null }, { value: "1\n", error: null }])).toBe(true);
});

test("a window without two readable endpoints has unavailable CPU, not zero", async () => {
  const observer = await observeProcess(process.pid, "empty window control", 50);
  const beforeMs = performance.now() + 10000;
  const result = await observer.stop({ beforeMs, afterMs: beforeMs + 1 });
  expect(result.includedSamples).toBe(0);
  expect(result.summary.observedCpuSeconds).toBeNull();
});

test("enabled or advancing scheduler counters cannot admit queue without wait-specific control", () => {
  const first = { pid: 1, processStartTicks: "1", tid: 2, beforeMs: 0, afterMs: 1,
    stat: { name: "fixture", minorFaults: 0, majorFaults: 0, userTicks: 0, systemTicks: 0, startTicks: 1 },
    schedstat: { value: "100 0 1", error: null }, allowedCPUs: "0" };
  for (const value of ["200 0 2", "200 100 2"]) {
    const last = { ...first, beforeMs: 100, afterMs: 101, stat: { ...first.stat, userTicks: 2 }, schedstat: { value, error: null } };
    const result = summarizeTask("1:1:2:1", { first, last, observations: 2 }, 100);
    expect(result.observedCpuSeconds).toBeGreaterThan(0);
    expect(result.observedQueueSeconds).toBeNull();
    expect(result.queueReason).toContain("No successful wait-counter positive control");
  }
});
