import assert from "node:assert/strict";
import { classifyMemoryProcess, decodeMemoryObservation, type EngineMemoryObservation } from "./browser-memory";
import type { MemoryProcessEnvelope, MemoryProcessRow, MemoryCensus } from "../../web/src/memory-telemetry";

export const memoryControlBytes = 1_073_807_360;
const entrySentinel = "SM_MEMORY_ENTRY ";
const caughtSentinel = "SM_MEMORY_CAUGHT ";
const resultSentinel = "SM_MEMORY_CONTROL ";

export function memoryControlCommand(): string {
  const child = `const mode=process.argv[1];
console.log(${JSON.stringify(entrySentinel)}+JSON.stringify({pid:process.pid,mode}));
if(mode==="ok") process.exit(0);
try { const buffer=new ArrayBuffer(${memoryControlBytes}); console.log(buffer.byteLength); }
catch { console.error(${JSON.stringify(caughtSentinel)}+JSON.stringify({pid:process.pid,mode})); process.exit(70); }
process.exit(1);`;
  const parent = `const {spawnSync}=require("node:child_process");
const children=["ok","fail"].map(mode=>{
const result=spawnSync("node",["-e",${JSON.stringify(child)},mode],{encoding:"utf8"});
process.stdout.write(result.stdout||""); process.stderr.write(result.stderr||"");
if(result.error||!Number.isInteger(result.pid)||result.pid<=0||result.status!==(mode==="ok"?0:70)||result.signal!==null) throw new Error("memory control child outcome");
if(!result.stdout.includes(${JSON.stringify(entrySentinel)})||(mode==="fail"&&!result.stderr.includes(${JSON.stringify(caughtSentinel)}))) throw new Error("memory control child entry");
return {mode,pid:result.pid,status:result.status,signal:result.signal};
});
console.log(${JSON.stringify(resultSentinel)}+JSON.stringify({pid:process.pid,children}));`;
  return `bun -e '${parent.replaceAll("'", "'\\''")}'`;
}
type Child = { mode: "ok" | "fail"; pid: number; status: number; signal: null };
export interface MemoryControlResult { pid: number; children: Child[] }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function pid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function childResult(value: unknown): value is Child {
  return object(value) && (value.mode === "ok" || value.mode === "fail") && pid(value.pid)
    && value.status === (value.mode === "ok" ? 0 : 70) && value.signal === null;
}
function sentinel(output: string, prefix: string): unknown[] {
  return output.split(/\r?\n/).filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
}
export function readMemoryControlResult(output: string): MemoryControlResult {
  const results = sentinel(output, resultSentinel);
  assert.equal(results.length, 1, "one real parent result");
  const result = results[0];
  assert.ok(object(result) && pid(result.pid) && Array.isArray(result.children) && result.children.every(childResult), "typed parent and child outcomes");
  const children: Child[] = result.children;
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(row => row.mode), ["ok", "fail"]);
  assert.equal(new Set(children.map(row => row.pid).concat([result.pid])).size, 3, "distinct actual PIDs");
  for (const child of children) assertChildSentinels(output, child);
  return { pid: result.pid, children };
}
function assertChildSentinels(output: string, child: Child): void {
  const matches = (value: unknown) => object(value) && value.pid === child.pid && value.mode === child.mode;
  assert.equal(sentinel(output, entrySentinel).filter(matches).length, 1, "post-entry child sentinel");
  assert.equal(sentinel(output, caughtSentinel).filter(matches).length, child.mode === "fail" ? 1 : 0, "caught-error child sentinel");
}
function matchingProcess(observation: MemoryProcessEnvelope, processPid: number, runtimeId?: string): MemoryProcessRow {
  const rows = observation.processes.filter(row => row.engine === "spidermonkey" && row.binding?.pid === processPid
    && (runtimeId === undefined || row.binding.runtimeId === runtimeId));
  assert.equal(rows.length, 1, "one bound runtime and PID witness");
  const row = rows[0];
  assert.ok(row?.binding);
  return row;
}
export function assertMemoryControl(output: string, read: EngineMemoryObservation): MemoryControlResult {
  const result = readMemoryControlResult(output);
  assert.equal(read.status, "observed", "real page getter must be available");
  assert.ok(read.status === "observed");
  const validated = decodeMemoryObservation(read.observation);
  assert.ok(validated.status === "observed", "valid supported page snapshot");
  const observation = validated.observation;
  assert.ok(Object.values(observation.loss).every(value => value === 0), "control evidence must not be evicted or truncated");
  const parent = matchingProcess(observation, result.pid);
  assert.ok(parent.binding);
  assert.ok(["pending", "no-failed-request"].includes(classifyMemoryProcess(parent)), "parent reflects its observed lifecycle");
  for (const child of result.children) assertChildObservation(observation, parent, child);
  return result;
}
function assertChildObservation(observation: MemoryProcessEnvelope, parent: MemoryProcessRow, child: Child): void {
  assert.ok(parent.binding);
  const row = matchingProcess(observation, child.pid, parent.binding.runtimeId);
  assert.equal(row.binding?.parentPid, parent.binding.pid, "measured child-to-parent edge");
  assert.equal(classifyMemoryProcess(row), child.mode === "ok" ? "no-failed-request" : "failed-request");
  assert.ok(row.sample && row.sample.time >= row.launchedAt && row.sample.wasmCapacityBytes !== null && row.sample.wasmCapacityBytes > 0);
  assert.ok(row.sample.memoryLimitBytes !== null && row.sample.memoryLimitBytes > 0);
  assert.ok(row.endedAt !== null && row.endSequence !== null && row.endSequence > row.launchSequence);
  assert.deepEqual(row.outcome, { kind: "observed", value: { kind: "exited", code: child.status, status: child.status << 8 } });
  if (child.mode === "ok") return;
  const failure = row.sample.frozenAllocatorFailure;
  assert.ok(failure && failure.category.startsWith("libc.") && failure.bytes !== null && failure.bytes >= memoryControlBytes, "real retained oversized libc request");
  assert.ok(failure.wasmCapacityAfterBytes !== null && failure.wasmCapacityAfterBytes > 0);
  const census = observation.censuses.find(item => item.runtimeId === parent.binding?.runtimeId && item.telemetryId === row.id);
  assert.ok(census && census.state === "observed" && census.truncated === 0 && census.unknownBytes === 0, "complete adapter-cleanup census");
  assert.ok(census.time >= row.endedAt && census.sequence > row.endSequence);
  for (const processPid of [child.pid, parent.binding.pid]) {
    const observedWorker: MemoryCensus["workers"][number] | undefined = census.workers.find(item => item.pid === processPid);
    assert.ok(observedWorker && observedWorker.bytes !== null && observedWorker.bytes > 0, "child and still-live parent have known worker samples");
  }
}
