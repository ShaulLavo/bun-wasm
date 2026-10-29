import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectMemorySnapshots } from "./app-matrix/engine-memory-hook.ts";

const [source, destination, field = "allProcesses"] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: replay-engine-lineage.ts RAW_JSONL REPORT_JSON [RAW_FIELD]");
const text = readFileSync(source, "utf8");
const results = text.trim().split("\n").map((line, index) => replay(JSON.parse(line), index + 1));
writeFileSync(destination, JSON.stringify({ source: resolve(source), sourceSha256: createHash("sha256").update(text).digest("hex"),
  rawField: field, result: "pass", frames: results, interpretation: "No numeric process lineage exists in these host frames. Aggregate/headroom and failure-time heap are unknown; raw facts are preserved." }, null, 2) + "\n");
console.log(`PASS ${results.length} production frames; complete observations retained; no inferred aggregate`);

function replay(value: unknown, line: number) {
  if (!value || typeof value !== "object" || !Array.isArray(Reflect.get(value, field))) throw new Error(`Missing complete raw getter list at line ${line}`);
  if (!("engine" in value) || value.engine !== "quickjs" && value.engine !== "jsc") throw new Error(`Unknown engine at line ${line}`);
  const raw: unknown = Reflect.get(value, field);
  if (!Array.isArray(raw)) throw new Error("Raw process list must be an array");
  const result = selectMemorySnapshots(raw, value.engine);
  assert.equal(result.attribution.kind, "unknown");
  for (const key of ["wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"] as const) assert.equal(result[key], null);
  assert.deepEqual(result.rawProcesses, raw);
  const observed = raw.filter((row): row is { id: string; terminal: boolean } => Boolean(row && typeof row === "object" && "id" in row && typeof row.id === "string" && "terminal" in row && typeof row.terminal === "boolean"));
  assert.deepEqual(result.processes.map(row => row.id), observed.map(row => row.id));
  const active = observed.filter(row => !row.terminal).map(row => row.id);
  assert(active.every(id => result.processes.some(row => row.id === id)));
  return { line, phase: "phase" in value ? value.phase : null, rawCount: raw.length, activeIds: active,
    terminalIds: observed.filter(row => row.terminal).map(row => row.id), attribution: result.attribution,
    observedFailures: result.observedFailures, result };
}
