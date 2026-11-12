import assert from "node:assert/strict";
import { classifyMemoryProcess, decodeMemoryObservation, type EngineMemoryObservation } from "./browser-memory";
import type { MemoryProcessEnvelope, MemoryProcessRow, MemoryCensus } from "../../web/src/memory-telemetry";

export const memoryControlBytes = 1_073_807_360;
const entrySentinel = "SM_MEMORY_ENTRY ";
const caughtSentinel = "SM_MEMORY_CAUGHT ";
const resultSentinel = "SM_MEMORY_CONTROL ";
interface MemoryControlBoundary { nonce: string; sequence: number }

export function memoryControlBoundary(read: EngineMemoryObservation, nonce: string): MemoryControlBoundary {
  assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);
  assert.ok(read.status === "observed", "pre-control getter must be available");
  const validated = decodeMemoryObservation(read.observation);
  assert.ok(validated.status === "observed", "valid pre-control observation boundary");
  assert.ok(Object.values(validated.observation.loss).every(value => value === 0), "pre-control observation has no retention loss");
  return { nonce, sequence: validated.observation.sequence };
}
export function memoryControlCommand(nonce: string): string {
  assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);
  const child = `const mode=process.argv[1],nonce=${JSON.stringify(nonce)};
console.log(${JSON.stringify(entrySentinel)}+JSON.stringify({nonce,mode}));
if(mode==="ok") process.exit(0);
try { const buffer=new ArrayBuffer(${memoryControlBytes}); console.log(buffer.byteLength); }
catch { console.error(${JSON.stringify(caughtSentinel)}+JSON.stringify({nonce,mode})); process.exit(70); }
process.exit(1);`;
  const parent = `const {spawnSync}=require("node:child_process"),nonce=${JSON.stringify(nonce)};
const children=["ok","fail"].map(mode=>{
const result=spawnSync("node",["-e",${JSON.stringify(child)},mode],{encoding:"utf8"});
process.stdout.write(result.stdout||""); process.stderr.write(result.stderr||"");
if(result.error||!Number.isInteger(result.pid)||result.pid<=0||result.status!==(mode==="ok"?0:70)||result.signal!==null) throw new Error("memory control child outcome");
if(result.stdout.trim()!==${JSON.stringify(entrySentinel)}+JSON.stringify({nonce,mode})||result.stderr.trim()!==(mode==="fail"?${JSON.stringify(caughtSentinel)}+JSON.stringify({nonce,mode}):"")) throw new Error("memory control child stream");
return {mode,pid:result.pid,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr};
});
console.log(${JSON.stringify(resultSentinel)}+JSON.stringify({nonce,children}));`;
  return `bun -e '${parent.replaceAll("'", "'\\''")}'`;
}
type Child = { mode: "ok" | "fail"; pid: number; status: number; signal: null; stdout: string; stderr: string };
export interface MemoryControlResult { nonce: string; children: Child[] }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function pid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function childResult(value: unknown): value is Child {
  return object(value) && (value.mode === "ok" || value.mode === "fail") && pid(value.pid)
    && value.status === (value.mode === "ok" ? 0 : 70) && value.signal === null
    && typeof value.stdout === "string" && value.stdout.length <= 1024 && typeof value.stderr === "string" && value.stderr.length <= 1024;
}
export function readMemoryControlResult(output: string, nonce: string): MemoryControlResult {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(resultSentinel));
  assert.equal(lines.length, 1, "one real parent result");
  const line = lines[0];
  assert.ok(line);
  const result: unknown = JSON.parse(line.slice(resultSentinel.length));
  assert.ok(object(result) && result.nonce === nonce && Array.isArray(result.children) && result.children.every(childResult), "nonce and typed returned child outcomes");
  const children: Child[] = result.children;
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(row => row.mode), ["ok", "fail"]);
  assert.equal(new Set(children.map(row => row.pid)).size, 2, "distinct actual returned PIDs");
  for (const child of children) assertChildSentinels(child, nonce);
  return { nonce, children };
}
function assertChildSentinels(child: Child, nonce: string): void {
  assert.equal(child.stdout.trim(), entrySentinel + JSON.stringify({ nonce, mode: child.mode }), "captured post-entry mode/nonce stream");
  assert.equal(child.stderr.trim(), child.mode === "fail" ? caughtSentinel + JSON.stringify({ nonce, mode: child.mode }) : "", "captured caught-error mode/nonce stream");
}
function matchingProcess(rows: readonly MemoryProcessRow[], processPid: number): MemoryProcessRow {
  const matches = rows.filter(row => row.binding?.pid === processPid);
  assert.equal(matches.length, 1, "one newly bound runtime and PID witness");
  const row = matches[0];
  assert.ok(row?.binding);
  return row;
}
function controlFamily(observation: MemoryProcessEnvelope, result: MemoryControlResult, boundary: MemoryControlBoundary) {
  const rows = observation.processes.filter(row => row.engine === "spidermonkey" && row.binding && row.launchSequence > boundary.sequence);
  const runtimeIds = new Set(rows.flatMap(row => row.binding ? [row.binding.runtimeId] : []));
  const candidates = Array.from(runtimeIds).filter(runtimeId => result.children.every(child => rows.some(row => row.binding?.runtimeId === runtimeId && row.binding.pid === child.pid)));
  assert.equal(candidates.length, 1, "exactly one runtime contains both newly bound returned children");
  const family = rows.filter(row => row.binding?.runtimeId === candidates[0]);
  const children = result.children.map(child => matchingProcess(family, child.pid));
  const parentPids = new Set(children.map(row => row.binding?.parentPid));
  assert.equal(parentPids.size, 1, "children share one measured host parent");
  const parentPid = parentPids.values().next().value;
  assert.ok(pid(parentPid) && !result.children.some(child => child.pid === parentPid), "distinct measured parent PID");
  return { parent: matchingProcess(family, parentPid), children };
}
export function assertMemoryControl(output: string, read: EngineMemoryObservation, boundary: MemoryControlBoundary) {
  const result = readMemoryControlResult(output, boundary.nonce);
  assert.ok(read.status === "observed", "real page getter must be available");
  const validated = decodeMemoryObservation(read.observation);
  assert.ok(validated.status === "observed", "valid supported page snapshot");
  const observation = validated.observation;
  assert.ok(observation.sequence > boundary.sequence, "host observations advanced after the pre-control boundary");
  assert.ok(Object.values(observation.loss).every(value => value === 0), "control evidence must not be evicted or truncated");
  const { parent } = controlFamily(observation, result, boundary);
  assert.ok(parent.binding);
  assert.ok(["pending", "no-failed-request"].includes(classifyMemoryProcess(parent)), "parent reflects its observed lifecycle");
  for (const child of result.children) assertChildObservation(observation, parent, child);
  return { ...result, identity: "returned-child-pids-and-host-parent", boundary, parent: { telemetryId: parent.id, ...parent.binding } };
}
function assertChildObservation(observation: MemoryProcessEnvelope, parent: MemoryProcessRow, child: Child): void {
  assert.ok(parent.binding);
  const row = matchingProcess(observation.processes.filter(row => row.binding?.runtimeId === parent.binding?.runtimeId), child.pid);
  assert.equal(row.binding?.parentPid, parent.binding.pid, "measured child-to-parent edge");
  assert.equal(classifyMemoryProcess(row), child.mode === "ok" ? "no-failed-request" : "failed-request");
  assert.ok(row.sample && row.sample.time >= row.launchedAt && row.sample.wasmCapacityBytes !== null && row.sample.wasmCapacityBytes > 0);
  assert.ok(row.sample.memoryLimitBytes !== null && row.sample.memoryLimitBytes > 0);
  assert.ok(row.endedAt !== null && row.endSequence !== null && row.endSequence > row.launchSequence);
  assert.deepEqual(row.outcome, { kind: "observed", value: { kind: "exited", code: child.status, status: child.status } });
  if (child.mode === "ok") return;
  const failure = row.sample.frozenAllocatorFailure;
  assert.ok(failure && failure.category.startsWith("libc.") && failure.bytes !== null && failure.bytes >= memoryControlBytes, "real retained oversized libc request");
  assert.ok(failure.wasmCapacityAfterBytes !== null && failure.wasmCapacityAfterBytes > 0);
  const matches = observation.censuses.filter(item => item.runtimeId === parent.binding?.runtimeId && item.telemetryId === row.id);
  assert.equal(matches.length, 1, "one retained child cleanup census");
  const census = matches[0];
  assert.ok(census && census.state === "observed" && census.truncated === 0 && census.unknownBytes === 0, "complete adapter-cleanup census");
  assert.equal(census.knownSampledBytesSubtotal, census.workers.reduce((sum, worker) => sum + (worker.bytes ?? 0), 0), "known sampled subtotal matches the retained rows");
  assert.ok(census.time >= row.endedAt && census.sequence > row.endSequence);
  assert.ok(parent.endSequence === null || parent.endSequence > census.sequence, "parent cleanup had not been observed at the child census");
  const childWorker = assertWorker(census, row), parentWorker = assertWorker(census, parent);
  assert.equal(childWorker.directory, parentWorker.directory, "broker corroborates the same process directory");
  assert.equal(childWorker.rootPid, parentWorker.rootPid, "broker corroborates the same root");
}
function assertWorker(census: MemoryCensus, process: MemoryProcessRow): MemoryCensus["workers"][number] {
  assert.ok(process.binding);
  const matches = census.workers.filter(item => item.pid === process.binding?.pid);
  assert.equal(matches.length, 1, "one matching broker process sample");
  const worker = matches[0];
  assert.ok(worker && worker.bytes !== null && worker.bytes > 0 && worker.rootPid > 0 && worker.directory.length > 0, "known child/parent worker identity and bytes");
  assert.equal(worker.parentPid, process.binding.parentPid, "broker and launcher agree on the parent edge");
  assert.equal(worker.job, process.binding.job, "broker and launcher agree on this process's observed job");
  return worker;
}
