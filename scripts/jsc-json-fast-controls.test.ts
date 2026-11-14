import { expect, test as bunTest } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nativeProducerEngines } from "./test-checks";

const test = bunTest.skipIf(!nativeProducerEngines().includes("jsc"));
const root = resolve(import.meta.dir, "..");
const launcher = process.env.BUN_WASM_LAUNCHER ?? `${process.env.CARGO_TARGET_DIR ?? "/work/tmp/bun-wasm-target"}/release/bun-wasm`;
const wasm = process.env.BUN_WASM_JSON_FAST_WASM ?? join(root, "dist/bun-jsc.wasm");
type RecordLine = Record<string, string | number | boolean | null>;
type Run = { records: RecordLine[]; dispatches: RecordLine[]; memory: RecordLine[]; linear: RecordLine[]; stdout: string; stderr: string };
const common = String.raw`
import assert from "node:assert/strict";
import { memoryUsage } from "bun:jsc";
import { linearMemoryBytes } from "bun:internal-for-testing";
function chain(n, array = false, leaf = 0) {
  let value = leaf;
  for (let i = 0; i < n; i++) value = array ? [value] : { a: value };
  return value;
}
function stealTable(value) {
  const twin = {};
  for (const key of Object.keys(value)) twin[key] = value[key];
  twin.transition = 0;
  return value;
}
function leaf(tag) {
  return stealTable({ ["value" + tag]: 1 });
}
function stressGraph(levels = 1000, leaves = 19) {
  let child = leaf("root");
  for (let i = levels - 1; i >= 0; i--) {
    const node = {};
    node["before" + i] = i;
    node["child" + i] = child;
    node["after" + i] = i;
    for (let j = 0; j < leaves; j++) node["leaf" + i + "_" + j] = leaf(i + "_" + j);
    child = stealTable(node);
  }
  Bun.gc(true);
  return child;
}
function sharedGraph() {
  const values = Array.from({ length: 2000 }, () => ({ value: 1 }));
  Object.keys(values[0]);
  const twin = { value: 1 };
  twin.transition = 0;
  Bun.gc(true);
  return { values };
}
function sampleMemory(label) {
  const usage = memoryUsage();
  console.error("bunwasm-json-fast-linear " + JSON.stringify({ label, capacity: linearMemoryBytes(), heapUsed: usage.heapUsed, extraMemory: usage.external }));
}
function equal(graph, gap) {
  const actual = JSON.stringify(graph(), undefined, gap);
  const expected = JSON.stringify(graph(), (_k, v) => v, gap);
  assert.equal(actual, expected);
  return actual.length;
}
function recovery() {
  Bun.gc(true);
  console.error("json-control recovery");
  equal(() => chain(200));
  Bun.gc(true);
  console.log("recovered");
}
`;

function parseLines(stderr: string, prefix: string): RecordLine[] {
  return stderr.split("\n").filter(line => line.startsWith(prefix)).map(line => {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    const parsed: RecordLine = {};
    for (const [key, field] of Object.entries(value)) {
      assert.ok(field === null || typeof field === "string" || typeof field === "number" || typeof field === "boolean");
      parsed[key] = field;
    }
    return parsed;
  });
}

function run(control: string, source: string, env: Record<string, string> = {}): Run {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-json-control-"));
  try {
    writeFileSync(join(scratch, "index.ts"), common + source);
    const settings = Object.assign({ BUN_WASM_JSC_JSON_FAST_TEST: control }, env);
    const flags = Object.entries(settings).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const command = [launcher, "--wasm", wasm, "--engine", `jsc=${wasm}`, "--dir", `${scratch}::/`, "--env", "PWD=/", "--env", "HOME=/"]
      .concat(flags, ["--", "run", "/index.ts"]);
    const result = Bun.spawnSync(command, { cwd: root, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    const stderr = result.stderr.toString();
    assert.equal(result.exitCode, 0, stderr);
    const records = parseLines(stderr, "bunwasm-json-fast ");
    const dispatches = parseLines(stderr, "bunwasm-json-fast-dispatch ");
    const memory = parseLines(stderr, "bunwasm-json-fast-memory ");
    const linear = parseLines(stderr, "bunwasm-json-fast-linear ");
    assert.ok(records.length > 0, "the compiled engine must report real fast attempts");
    return { records, dispatches, memory, linear, stdout: result.stdout.toString(), stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const refusalSource = (depth: number, effectDepth: number, array: boolean, gap?: number | string) => String.raw`
function graph(log) {
  const proxy = new Proxy({ end: 0 }, { get(t, k, r) { log.push("get " + String(k)); return Reflect.get(t, k, r); } });
  const json = { toJSON() { log.push("toJSON"); return proxy; } };
  const accessor = { get a() { log.push("getter"); return json; } };
  return chain(${effectDepth}, ${array}, chain(${depth - effectDepth}, ${array}, accessor));
}
const a = [], b = [];
assert.equal(JSON.stringify(graph(a), undefined, ${JSON.stringify(gap)}), JSON.stringify(graph(b), (_k, v) => v, ${JSON.stringify(gap)}));
assert.deepEqual(a, b);
assert.equal(a.filter(x => x === "getter").length, 1);
assert.equal(a.filter(x => x === "toJSON").length, 1);
recovery();
`;

const refusals = [
  { name: "F1", control: "fail-frame-growth:1", depth: 40, effect: 30, array: false, gap: undefined, frames: 16, roots: 32, frameCapacity: 16, rootCapacity: 32, registered: true, relocated: false },
  { name: "F2", control: "fail-frame-growth:3", depth: 100, effect: 80, array: false, gap: "\t", frames: 64, roots: 128, frameCapacity: 64, rootCapacity: 128, registered: true, relocated: false },
  { name: "R1", control: "fail-root-growth:1", depth: 40, effect: 30, array: false, gap: undefined, frames: 8, roots: 16, frameCapacity: 16, rootCapacity: 16, registered: false, relocated: false },
  { name: "R2", control: "fail-root-growth:2", depth: 40, effect: 30, array: false, gap: 2, frames: 16, roots: 32, frameCapacity: 32, rootCapacity: 32, registered: true, relocated: true },
  { name: "R3", control: "fail-root-growth:1", depth: 40, effect: 30, array: true, gap: undefined, frames: 15, roots: 15, frameCapacity: 16, rootCapacity: 16, registered: false, relocated: false },
  { name: "R4", control: "fail-root-growth:5", depth: 200, effect: 150, array: false, gap: undefined, frames: 128, roots: 256, frameCapacity: 256, rootCapacity: 256, registered: true, relocated: true },
];
for (const row of refusals) {
  test(`real allocation refusal ${row.name} restores roots and permits later fast success`, () => {
    const result = run(row.control, refusalSource(row.depth, row.effect, row.array, row.gap));
    const faults = result.records.filter(record => record.fault !== "none");
    expect(faults).toHaveLength(1);
    const fault = faults[0];
    assert.ok(fault);
    expect(fault).toMatchObject({
      attempt: 1, outcome: "FastFrameAllocation", framesAtFailure: row.frames, rootsAtFailure: row.roots,
      frameCapacityAtFailure: row.frameCapacity, rootCapacityAtFailure: row.rootCapacity,
      rootsRegisteredAtFailure: row.registered, frameRelocatedInFailingReserve: row.relocated,
      depthAtFailure: row.gap === undefined ? 0 : row.frames,
      fault: row.control.replace("fail-frame-growth:", "frame:").replace("fail-root-growth:", "root:"),
    });
    expect(Number(fault.outputLengthAtFailure)).toBeGreaterThan(0);
    assert.ok(result.dispatches.some(dispatch => dispatch.markListAtGeneral !== null));
    for (const dispatch of result.dispatches.filter(item => item.markListAtGeneral !== null)) expect(dispatch.markListAtGeneral).toBe(dispatch.markListAtEntry);
    expect(result.records.some(record => record.outcome === "success" && record.maxFrames === 200 && record.fault === "none")).toBe(true);
    expect(result.stdout).toContain("recovered");
  }, 600_000);
}

for (const [depth, array, frames, roots, movedFrames, movedRoots] of [
  [16, false, 0, 1, 0, 16], [1024, false, 6, 7, 1008, 2032],
  [4095, false, 8, 9, 4080, 8176], [4095, true, 8, 8, 4080, 4072],
] satisfies [number, boolean, number, number, number, number][]) {
  test(`geometric growth at ${depth} ${array ? "array" : "object"} containers`, () => {
    const result = run("record", `equal(() => chain(${depth}, ${array}));`);
    expect(result.records.filter(record => record.outcome === "success")).toContainEqual(expect.objectContaining({ frameGrowths: frames, rootGrowths: roots, framesMoved: movedFrames, rootSlotsMoved: movedRoots }));
  }, 600_000);
}

for (const depth of [4094, 4095, 4096, 4097, 39998, 39999, 40000]) {
  test(`compact depth ${depth} succeeds across the fast cap`, () => {
    const result = run("record", `assert.equal(equal(() => chain(${depth})), ${depth * 6 + 1});`);
    expect(result.records.some(record => record.outcome === (depth <= 4095 ? "success" : "FastNesting"))).toBe(true);
  }, 600_000);
}

test("general depth limit remains authoritative", () => {
  run("record", String.raw`
const graph = chain(40001);
let fast, general;
try { JSON.stringify(graph); } catch (e) { assert.ok(e instanceof RangeError); fast = String(e); }
try { JSON.stringify(graph, (_k, v) => v); } catch (e) { assert.ok(e instanceof RangeError); general = String(e); }
assert.equal(typeof fast, "string");
assert.equal(fast, general);
recovery();
`);
}, 600_000);

function collectionSuccess(result: Run, materializations: number): RecordLine {
  const record = result.records.find(item => item.outcome === "success");
  assert.ok(record, result.stderr);
  expect(Number(record.materializations)).toBeGreaterThanOrEqual(materializations);
  expect(Number(record.collectionsWithLiveFrames)).toBeGreaterThan(0);
  expect(Number(record.clearedLiveTables)).toBeGreaterThan(0);
  expect(Number(record.resumesOfClearedTableFrames)).toBeGreaterThan(0);
  expect(Number(record.forcedCollectionsAtA)).toBeGreaterThan(0);
  expect(Number(record.forcedCollectionsAtB)).toBeGreaterThan(0);
  expect(record.collectionSkippedDeferred).toBe(0);
  expect(result.stdout).toContain("collection passed");
  return record;
}

for (const ordinal of [1, 7]) {
  // Ordinal 1 forces two full collections at every open (about 4 ms each), so it walks 4 leaves per level instead of 19.
  const leaves = ordinal === 1 ? 4 : 19;
  test(`collection resumes deep rooted frames at open ordinal ${ordinal}`, () => {
    const result = run(`collect-at-open:${ordinal}`, String.raw`
const graph = stressGraph(1000, ${leaves});
assert.equal(JSON.stringify(graph), JSON.stringify(graph, (_k, v) => v));
console.log("collection passed");
`);
    const record = collectionSuccess(result, 1000 * (leaves + 1));
    expect(record.rootsEverRegistered).toBe(true);
  }, 600_000);

  test(`collection resumes inline rooted frames at open ordinal ${ordinal}`, () => {
    const result = run(`collect-at-open:${ordinal}`, String.raw`
const graph = stressGraph(4, 2000);
assert.equal(JSON.stringify(graph), JSON.stringify(graph, (_k, v) => v));
console.log("collection passed");
`);
    const record = collectionSuccess(result, 8000);
    expect(record.rootCapacityAtExit).toBe(16);
    expect(record.rootsEverRegistered).toBe(false);
  }, 600_000);
}

test("collection rematerializes a shared structure while older tables stay rooted", () => {
  const result = run("collect-at-open:1", String.raw`
const graph = sharedGraph();
assert.equal(JSON.stringify(graph), JSON.stringify(graph, (_k, v) => v));
console.log("collection passed");
`);
  collectionSuccess(result, 2000);
}, 600_000);

test.if(process.env.BUN_WASM_JSON_LONG_STRESS === "1")("JSC slow-allocation GC pressure reaches the running guest", () => {
  const result = run("record", String.raw`
const graph = stressGraph(20, 20);
assert.equal(JSON.stringify(graph), JSON.stringify(graph, (_k, v) => v));
console.log("collection passed");
`, { JSC_slowPathAllocsBetweenGCs: "1" });
  const record = result.records.find(item => item.outcome === "success");
  assert.ok(record);
  expect(Number(record.collections)).toBeGreaterThan(0);
  expect(result.stdout).toContain("collection passed");
}, 600_000);

const pressureSource = String.raw`
const graph = stressGraph();
const deep = chain(4095);
const ballastBytes = Number(process.env.BUN_WASM_JSON_BALLAST_BYTES || 0);
const ballast = ballastBytes ? new Uint8Array(ballastBytes) : null;
const retainedBytes = Number(process.env.BUN_WASM_JSON_RETAIN_BYTES || 0);
let retained = null;
const donor = process.env.BUN_WASM_JSON_DONOR === "1";
Bun.gc(true);
sampleMemory("pre");
for (let batch = 0; batch < 3; batch++) {
  for (let run = 0; run < 50; run++) {
    assert.equal(JSON.stringify(graph), JSON.stringify(graph, (_k, v) => v));
    assert.equal(JSON.stringify(deep, donor ? (_k, v) => v : undefined), JSON.stringify(deep, (_k, v) => v));
  }
  if (batch === 1 && retainedBytes) retained = new Uint8Array(retainedBytes);
  sampleMemory("peak " + batch);
  Bun.gc(true);
  sampleMemory("recovered " + batch);
}
assert.ok(graph);
assert.ok(deep);
assert.equal(ballast ? ballast.length : 0, ballastBytes);
assert.equal(retained ? retained.length : 0, retainedBytes);
console.log("pressure passed");
`;

const collectionPressureSource = String.raw`
const graph = stressGraph(20, 5);
const ballastBytes = Number(process.env.BUN_WASM_JSON_BALLAST_BYTES || 0);
const ballast = ballastBytes ? new Uint8Array(ballastBytes) : null;
Bun.gc(true);
sampleMemory("pre");
for (let batch = 0; batch < 3; batch++) {
  for (let run = 0; run < 3; run++)
    assert.equal(JSON.stringify(graph), JSON.stringify(graph, (_k, v) => v));
  sampleMemory("peak " + batch);
  Bun.gc(true);
  sampleMemory("recovered " + batch);
}
assert.ok(graph);
assert.equal(ballast ? ballast.length : 0, ballastBytes);
console.log("pressure passed");
`;

function assertRecovery(result: Run): void {
  const readings = result.memory.map((memory, index) => ({ label: result.linear[index]?.label, ...memory }));
  const diagnostics = JSON.stringify(readings);
  expect(result.memory, diagnostics).toHaveLength(7);
  expect(result.linear, diagnostics).toHaveLength(7);
  const pre = result.memory[0];
  const recovered = result.memory.filter((_, index) => index > 0 && index % 2 === 0);
  const first = recovered[0];
  assert.ok(pre && first, diagnostics);
  // JSC retains warmed tables and arenas. Their one-time cost must not become a per-cycle allowance.
  for (const metric of ["live", "heapUsed"]) {
    for (const post of recovered) {
      const recovery: number = Number(post[metric]) - Number(pre[metric]);
      const growth: number = Number(post[metric]) - Number(first[metric]);
      assert.ok(recovery <= 8 * 1024 * 1024, `${metric} did not recover within 8 MiB: ${diagnostics}`);
      assert.ok(growth <= 256 * 1024, `${metric} recovery grew by more than 256 KiB: ${diagnostics}`);
    }
  }
}

function assertRecordPressure(result: Run): void {
  expect(result.stdout).toContain("pressure passed");
  const stress = result.records.filter(record => record.outcome === "success" && record.maxFrames === 1001);
  expect(stress).toHaveLength(150);
  const attempts = result.records.filter(record => record.maxFrames === 305 || record.maxFrames === 1001);
  expect(attempts).toHaveLength(300);
  for (const index of [0, 50, 100]) {
    const materializations = Number(attempts[index * 2]?.materializations) + Number(attempts[index * 2 + 1]?.materializations);
    expect(materializations).toBeGreaterThanOrEqual(20000);
  }
  assertRecovery(result);
}

function assertCollectionPressure(result: Run): void {
  expect(result.stdout).toContain("pressure passed");
  const stress = result.records.filter(record => record.outcome === "success" && record.maxFrames === 21);
  expect(stress).toHaveLength(9);
  for (const record of stress) {
    expect(Number(record.collectionsWithLiveFrames)).toBeGreaterThan(0);
    expect(Number(record.materializations)).toBeGreaterThanOrEqual(1);
    expect(record.rootsEverRegistered).toBe(true);
  }
  assertRecovery(result);
}

const ballast = { BUN_WASM_JSON_BALLAST_BYTES: String(Math.floor(1073741824 * 0.7)) };

test("repeated record pressure recovers heap and allocator bytes with ballast", () => {
  assertRecordPressure(run("record", pressureSource));
  assertRecordPressure(run("record", pressureSource, ballast));
}, 600_000);

test("bounded collection pressure recovers heap and allocator bytes with ballast", () => {
  assertCollectionPressure(run("collect-at-open:7", collectionPressureSource));
  assertCollectionPressure(run("collect-at-open:7", collectionPressureSource, ballast));
}, 600_000);

test("recovery rejects a 384 KiB buffer retained across pressure cycles with ballast", () => {
  const result = run("record", pressureSource, { ...ballast, BUN_WASM_JSON_RETAIN_BYTES: String(384 * 1024) });
  expect(() => assertRecovery(result)).toThrow("live recovery grew by more than 256 KiB");
}, 600_000);
