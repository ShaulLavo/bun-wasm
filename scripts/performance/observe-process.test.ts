import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservation, finishObservation } from "./sharing-controls";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { observeProcess, parseTaskStat } from "./observe-process";
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
