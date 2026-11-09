import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { WorkerJobs } from "../tests/shell-product/worker-jobs.ts";

for (const mode of ["held", "void", "fulfilled", "throw", "reject", "reject-falsy", "reentrant"]) test(`real CPU root observes native return: ${mode}`, () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/runner-observation-probe.ts", import.meta.url).pathname, mode], { encoding: "utf8", timeout: 5000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`PASS CPU root observation ${mode}`);
});

for (const mode of ["terminal-selected", "terminal-terminated", "nested-selected", "nested-terminated"]) test(`real CPU Bun entry retains observation through imports: ${mode}`, () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/worker-entry-observation-probe.ts", import.meta.url).pathname, mode], { encoding: "utf8", timeout: 5000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`PASS held Bun entry import ${mode}`);
});

for (const mode of ["held", "void", "fulfilled", "throw", "reject", "reject-falsy", "reentrant"]) test(`real CPU root acquired after disposal keeps its native obligation: ${mode}`, () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/late-root-observation-probe.ts", import.meta.url).pathname, mode], { encoding: "utf8", timeout: 5000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`PASS late CPU root observation ${mode}`);
});


test("posted Worker ownership preserves its admitted lifetime and rejects old or foreign tokens", () => {
  const transport = createWorkerProcessTransport({ pid: 23, job: 20 });
  const { lifetime: _lifetime, ...oldShape } = transport;
  for (const posted of [transport, oldShape, { ...transport, lifetime: new SharedArrayBuffer(16) }]) {
    const worker = {};
    const jobs = new WorkerJobs(new Set([worker]), () => false);
    jobs.observe(worker, { runtimeProcess: posted });
    if (posted === transport) expect(jobs.baseline(23).root.pid).toBe(23);
    else expect(() => jobs.baseline(23)).toThrow();
  }
});

for (const mode of ["held", "throw", "reject", "reject-falsy"]) test(`real Node CPU root and child retain native-return observation: ${mode}`, () => {
  const result = spawnSync("node", ["--no-warnings", new URL("../web/tests/fixtures/node-observation-probe.ts", import.meta.url).pathname, mode], { encoding: "utf8", timeout: 5000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`PASS Node root and child observation ${mode}`);
});

test("real Node natural root exit preserves the host's selected result before ending observation", () => {
  const result = spawnSync("node", ["--no-warnings", new URL("../web/tests/fixtures/node-natural-observation-probe.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 5000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain("PASS Node natural root observation");
});
