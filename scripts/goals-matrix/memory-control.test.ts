import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { assertMemoryControl, memoryControlBytes, memoryControlCommand, memoryControlBoundary, readMemoryControlResult, type MemoryControlResult } from "./memory-control";
import { classifyMemoryProcess, decodeMemoryObservation, engineMemoryLog, readEngineMemory } from "./browser-memory";
import { execute } from "./execute";
import { frameworks } from "./catalog";
import type { Transport } from "./transport";
import type { MemoryProcessEnvelope, MemoryProcessRow } from "../../web/src/memory-telemetry";
import { discoverChecks, selectChecks } from "../test-checks";
import { checkInputPaths } from "../ci-check-inputs";
const nonce = "synthetic-memory-control-nonce";
const boundary = { nonce, sequence: 5 };

function syntheticProcess(pid: number, parentPid: number): MemoryProcessRow {
  return { id: `synthetic-${pid}`, engine: "spidermonkey", binding: { runtimeId: "synthetic-runtime", pid, parentPid, job: 1 },
    launchedAt: 10, launchSequence: 10 + pid, endedAt: 20, endSequence: 30 + pid, outcome: { kind: "observed", value: { kind: "exited", code: 0, status: 0 } },
    status: "sampled", outcomeBoundary: "revocation", engineHeap: "unsupported", sample: { time: 19, terminal: true, wasmCapacityBytes: 16777216, memoryLimitBytes: 1073741824,
      allocatorLiveBytes: 1000, allocatorPeakBytes: 2000, allocatorFailure: null, frozenAllocatorFailure: null, libcTelemetry: { allocator: "read", failure: "read" } } };
}
function syntheticControl(): { output: string; observation: MemoryProcessEnvelope } {
  const parent = syntheticProcess(1, 0), ok = syntheticProcess(2, 1), fail = syntheticProcess(3, 1);
  parent.endedAt = 50;
  parent.endSequence = 50;
  fail.outcome = { kind: "observed", value: { kind: "exited", code: 70, status: 70 } };
  if (!fail.sample) throw Error("synthetic fixture requires a sample");
  fail.sample.frozenAllocatorFailure = { bytes: memoryControlBytes, category: "libc.calloc", previousUsableBytes: null,
    allocatorLiveBytes: 1000, allocatorPeakBytes: 2000, wasmCapacityBeforeBytes: null, wasmCapacityAfterBytes: 16777216, reason: "unknown" };
  const children: MemoryControlResult["children"] = (["ok", "fail"] as const).map((mode, index) => ({ mode, pid: index + 2, status: mode === "ok" ? 0 : 70, signal: null,
    stdout: "SM_MEMORY_ENTRY " + JSON.stringify({ nonce, mode }) + "\n", stderr: mode === "fail" ? "SM_MEMORY_CAUGHT " + JSON.stringify({ nonce, mode }) + "\n" : "" }));
  const output = "SM_MEMORY_CONTROL " + JSON.stringify({ nonce, children });
  return { output, observation: { schema: 1, time: 50, sequence: 60, sharedBuffers: true, processes: [parent, ok, fail], runtimes: [],
    censuses: [{ runtimeId: "synthetic-runtime", telemetryId: fail.id, boundary: "adapter-cleanup", time: 21, sequence: 40, state: "observed",
      truncated: 0, unknownBytes: 0, knownSampledBytesSubtotal: 33554432, aliasing: "uncertain", workers: [1, 3].map(pid => ({ pid, parentPid: pid === 1 ? 0 : 1,
        rootPid: 1, job: 1, directory: "synthetic-directory", bytes: 16777216, engine: "spidermonkey" })) }],
    loss: { active: 0, terminal: 0, runtimes: 0, censuses: 0, outputCensuses: 0, outputWorkerRows: 0, outputProcesses: 0 }, incomplete: false } };
}
function failingChild(observation: MemoryProcessEnvelope): MemoryProcessRow {
  const row = observation.processes[2];
  if (!row?.sample) throw Error("missing synthetic failing child");
  return row;
}
test("synthetic rows qualify only the pure assertions, not a live engine", () => {
  const fixture = syntheticControl();
  expect(assertMemoryControl(fixture.output, { status: "observed", observation: fixture.observation }, boundary).parent.pid).toBe(1);
  expect(memoryControlCommand(nonce)).toContain(`new ArrayBuffer(${memoryControlBytes})`);
  expect(memoryControlCommand(nonce)).not.toContain("maxByteLength");
  expect(memoryControlCommand(nonce)).not.toContain("process.pid");
});

const corruptions: [string, (value: MemoryProcessEnvelope) => void][] = [
  ["missing PID binding", value => { failingChild(value).binding = null; }],
  ["wrong runtime binding", value => { const binding = failingChild(value).binding; if (binding) binding.runtimeId = "another-runtime"; }],
  ["missing snapshot", value => { failingChild(value).sample = null; }],
  ["missing frozen export", value => { const sample = failingChild(value).sample; if (sample) sample.libcTelemetry = { allocator: "read", failure: "unsupported" }; }],
  ["synthetic zero placeholder", value => { const sample = failingChild(value).sample; if (sample) { delete sample.libcTelemetry; sample.frozenAllocatorFailure = null; } }],
  ["unread sample", value => { failingChild(value).status = "read-failed"; }],
  ["cached live sample", value => { const sample = failingChild(value).sample; if (sample) sample.terminal = false; }],
  ["missing actual failure", value => { const sample = failingChild(value).sample; if (sample) sample.frozenAllocatorFailure = null; }],
  ["evicted terminal identity", value => { value.loss.terminal = 1; }],
  ["unknown outcome", value => { failingChild(value).outcome = { kind: "observed", value: null }; }],
  ["failed outcome read", value => { failingChild(value).outcome = { kind: "unavailable", reason: "read-failed" }; }],
  ["truncated census", value => { const census = value.censuses[0]; if (census) census.truncated = 1; }],
  ["missing parent sample", value => { const census = value.censuses[0]; if (census) census.workers = census.workers.filter(worker => worker.pid !== 1); }],
  ["already-cleaned parent", value => { const parent = value.processes[0]; if (parent) parent.endSequence = 1; }],
  ["synthetic zero subtotal", value => { const census = value.censuses[0]; if (census) census.knownSampledBytesSubtotal = 0; }],
  ["stale launch before the boundary", value => { failingChild(value).launchSequence = boundary.sequence; }],
  ["missing parent identity", value => { value.processes = value.processes.filter(row => row.binding?.pid !== 1); }],
  ["ambiguous parent identity", value => { const parent = value.processes[0]; if (parent) value.processes.push({ ...parent, id: "ambiguous-parent" }); }],
  ["mismatched parent edges", value => { const binding = failingChild(value).binding; if (binding) binding.parentPid = 9; }],
  ["different broker directory", value => { const worker = value.censuses[0]?.workers[1]; if (worker) worker.directory = "other-directory"; }],
  ["different broker root", value => { const worker = value.censuses[0]?.workers[1]; if (worker) worker.rootPid = 99; }],
  ["different broker parent edge", value => { const worker = value.censuses[0]?.workers[1]; if (worker) worker.parentPid = 99; }],
  ["ambiguous runtimes", value => { value.processes = value.processes.concat(value.processes.map(row => ({ ...row, id: row.id + "-other",
    binding: row.binding ? { ...row.binding, runtimeId: "other-runtime" } : null }))); }],
];
test.each(corruptions)("synthetic red control rejects %s", (_name, corrupt) => {
  const fixture = syntheticControl();
  corrupt(fixture.observation);
  expect(() => assertMemoryControl(fixture.output, { status: "observed", observation: fixture.observation }, boundary)).toThrow();
});
test("entry, caught-error and actual returned PIDs are all mandatory", () => {
  const { output } = syntheticControl();
  expect(() => readMemoryControlResult(output.replace("SM_MEMORY_ENTRY", "missing-entry"), nonce)).toThrow();
  expect(() => readMemoryControlResult(output.replace("SM_MEMORY_CAUGHT", "missing-catch"), nonce)).toThrow();
  expect(() => readMemoryControlResult(output.replace('"pid":3,"status":70', '"pid":0,"status":70'), nonce)).toThrow();
});
test.each(["streams", "pids", "nonce"])("captured stream/PID control rejects swapped or mismatched %s", kind => {
  const fixture = syntheticControl();
  const result = readMemoryControlResult(fixture.output, nonce);
  const ok = result.children[0], fail = result.children[1];
  if (!ok || !fail) throw Error("missing synthetic results");
  if (kind === "streams") [ok.stdout, fail.stdout] = [fail.stdout, ok.stdout];
  if (kind === "pids") [ok.pid, fail.pid] = [fail.pid, ok.pid];
  if (kind === "nonce") fail.stderr = fail.stderr.replace(nonce, "mismatched-nonce");
  expect(() => assertMemoryControl("SM_MEMORY_CONTROL " + JSON.stringify(result), { status: "observed", observation: fixture.observation }, boundary)).toThrow();
});
test("pre-control boundary requires a readable supported getter and no retention loss", () => {
  const { observation } = syntheticControl();
  expect(memoryControlBoundary({ status: "observed", observation }, nonce)).toEqual({ nonce, sequence: observation.sequence });
  expect(() => memoryControlBoundary({ status: "unavailable", reason: "getter-unavailable" }, nonce)).toThrow();
  observation.loss.active = 1;
  expect(() => memoryControlBoundary({ status: "observed", observation }, nonce)).toThrow();
});
test("classification separates unsupported records, cached samples and frozen failure capacity", () => {
  const row = syntheticProcess(7, 1);
  expect(classifyMemoryProcess(row)).toBe("no-failed-request");
  if (!row.sample) throw Error("missing synthetic sample");
  delete row.sample.libcTelemetry;
  expect(classifyMemoryProcess(row)).toBe("unsupported");
  row.sample.libcTelemetry = { allocator: "read", failure: "read" };
  row.sample.terminal = false;
  expect(classifyMemoryProcess(row)).toBe("cached-live");
  row.endedAt = null;
  expect(classifyMemoryProcess(row)).toBe("pending");
  row.binding = null;
  expect(classifyMemoryProcess(row)).toBe("unbound");
});
test("invalid and unsupported observation channels cannot synthesize zero records", async () => {
  const transport = { async useHost() {}, async evaluate<T>(expression: string): Promise<T> { return runInNewContext(expression); } };
  expect(await readEngineMemory(transport)).toEqual({ status: "unavailable", reason: "getter-unavailable" });
  expect(decodeMemoryObservation({ schema: 2 })).toMatchObject({ status: "unavailable" });
  const { observation } = syntheticControl();
  observation.sharedBuffers = false;
  expect(decodeMemoryObservation(observation)).toEqual({ status: "unavailable", reason: "shared-buffers-unavailable" });
  expect(decodeMemoryObservation({ ...observation, sharedBuffers: true, processes: [{}] })).toMatchObject({ status: "unavailable" });
  expect(await readEngineMemory({ ...transport, async useHost() { throw Error("private unrelated error"); } })).toEqual({ status: "unavailable", reason: "host-read-failed" });
});
test("campaign reader validates and projects synthetic rows without arbitrary context or error text", async () => {
  const { observation } = syntheticControl();
  Reflect.set(observation, "privateContext", { path: "/private", env: "secret" });
  Reflect.set(observation.processes[0] ?? {}, "request", "secret request");
  const transport = { async useHost() {}, async evaluate<T>(expression: string): Promise<T> {
    return runInNewContext(expression, { __bunMemoryProcesses: () => observation });
  } };
  const log = await engineMemoryLog(transport, "spidermonkey");
  expect(log).toContain('"state":"failed-request"');
  expect(log).not.toContain("secret");
  expect(log).not.toContain("privateContext");
  expect(await engineMemoryLog(transport, "quickjs")).toBe("");
});
test("manifests select the real split browser producer once with precise production inputs", () => {
  const checks = discoverChecks();
  const live = checks.find(check => check.path === "scripts/spidermonkey-memory-browser.test.ts");
  expect(live?.owner).toBe("browser-guest");
  expect(selectChecks("browser-guest", checks, "split")).toContain(live?.path ?? "missing");
  expect(selectChecks("browser-guest", checks, "shared-group")).not.toContain(live?.path ?? "missing");
  if (!live) throw Error("missing live manifest");
  for (const file of ["web/src/memory-telemetry.ts", "web/src/bun-launcher.ts", "scripts/goals-matrix/browser-memory.ts", "scripts/goals-matrix/execute.ts", "scripts/goals-matrix/memory-control.ts"]) expect(checkInputPaths(live)).toContain(file);
  expect(checks.filter(check => check.path === "scripts/goals-matrix/memory-control.test.ts")).toHaveLength(1);
  expect(checks.filter(check => check.path === "scripts/engine-memory-hook.test.ts")).toHaveLength(1);
  const source = readFileSync(new URL("../spidermonkey-memory-browser.test.ts", import.meta.url), "utf8");
  expect(source).toContain("engineMemoryLog");
  expect(source).toContain("verifySite");
  expect(source).not.toContain("test.skip");
});

test.each([[false, false], [true, false], [false, true], [true, true]])("synthetic startup failure saves before cleanup, owned = %s, stalled = %s", async (owned, stalled) => {
  const framework = frameworks[0];
  if (!framework) throw Error("missing framework fixture");
  let closed = false;
  const saves: string[] = [];
  const diagnostic = Promise.withResolvers<void>();
  const fixture = syntheticControl();
  const transport: Transport = { capabilities: { synthetic: true }, async navigate() { throw Error("synthetic original startup failure"); },
    async useHost() {}, async usePreview() {}, async openPreview() {}, async closePreview() {},
    async evaluate<T>(expression: string): Promise<T> {
      if (stalled && expression.includes("retainedProcessFacts")) await diagnostic.promise;
      return runInNewContext(expression, { __bunMemoryProcesses: () => fixture.observation,
        playground: { term: { write(_text: string, callback: () => void) { callback(); }, buffer: { active: { length: 0 } } },
          shell: { running: false }, previews: { serves: () => false } } });
    }, async close() { closed = true; } };
  if (owned) transport.cleanup = async () => { closed = true; return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
  const result = await execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "spidermonkey" }, url: "http://synthetic/", timeoutMs: 1000,
    async createTransport() { return transport; }, async saveLog(text) { expect(closed).toBe(false); saves.push(text); } });
  expect(result).toMatchObject({ status: "fail", phase: "startup" });
  if (result.status !== "fail") throw Error("expected synthetic startup failure");
  expect(result.error).toContain("synthetic original startup failure");
  expect(closed).toBe(true);
  expect(saves.join("\n")).toContain(stalled ? '"reason":"observation-budget"' : '"state":"failed-request"');
  expect(result.attempts[0]?.phases.find(phase => phase.phase === "cleanup")?.status).toBe("pass");
  const saved = saves.slice();
  diagnostic.resolve();
  await Bun.sleep(0);
  expect(saves).toEqual(saved);
}, 10000);
