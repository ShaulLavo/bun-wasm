import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const launcher = process.env.BUN_WASM_LAUNCHER ?? `${process.env.CARGO_TARGET_DIR ?? "/work/tmp/bun-wasm-target"}/release/bun-wasm`;
const wasm = process.env.BUN_WASM_JSON_FAST_WASM ?? join(root, "dist/bun-jsc.wasm");
type RecordLine = Record<string, string | number | boolean | null>;
type Run = { records: RecordLine[]; dispatches: RecordLine[]; stdout: string };
const common = String.raw`
import assert from "node:assert/strict";
function chain(n, array = false, leaf = 0) {
  let value = leaf;
  for (let i = 0; i < n; i++) value = array ? [value] : { a: value };
  return value;
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
    assert.ok(records.length > 0, "the compiled engine must report real fast attempts");
    return { records, dispatches, stdout: result.stdout.toString() };
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

for (const depth of [4094, 4095, 4096, 4097, 39998, 39999]) {
  test(`compact depth ${depth} succeeds across the fast cap`, () => {
    const result = run("record", `assert.equal(equal(() => chain(${depth})), ${depth * 6 + 1});`);
    expect(result.records.some(record => record.outcome === (depth <= 4095 ? "success" : "FastNesting"))).toBe(true);
  }, 600_000);
}

test("general depth limit remains authoritative", () => {
  run("record", String.raw`
const graph = chain(40000);
let fast, general;
try { JSON.stringify(graph); } catch (e) { assert.ok(e instanceof RangeError); fast = String(e); }
try { JSON.stringify(graph, (_k, v) => v); } catch (e) { assert.ok(e instanceof RangeError); general = String(e); }
assert.equal(typeof fast, "string");
assert.equal(fast, general);
recovery();
`);
}, 600_000);
