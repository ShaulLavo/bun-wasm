import { expect, spyOn, test } from "bun:test";
import { beginMemorySnapshot, createMemoryReader, emptyCounters, endMemorySnapshot, recordMemorySnapshot, retainedMemorySnapshots } from "../web/src/memory-telemetry.ts";
import { createMemoryChannel, createMemoryPublisher, memoryChannelReady, observeMemoryImports, readMemoryChannel, requestMemoryChannel } from "../web/src/memory-channel.ts";
import { aggregate, selectMemorySnapshots } from "./app-matrix/engine-memory-hook.ts";

// Passed through as the core's declared maximum; any page multiple shows it is not a constant.
const LIMIT_BYTES = 7 * 65536;

function fixture(engine: "jsc" | "quickjs") {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const put = (base: number, index: number, value: bigint) => view.setBigUint64(base + index * 8, value, true);
  for (let index = 0; index < 24; index++) put(256, index, 0xffffffffffffffffn);
  put(128, 0, 1n); put(128, 1, 80n); put(128, 2, 10000n); put(128, 3, 20000n); put(128, 5, 0n);
  put(256, 0, 1n); put(256, 1, engine === "jsc" ? 192n : 96n); put(256, 2, 1n);
  put(256, engine === "jsc" ? 21 : 9, 0n);
  let refreshes = 0;
  let trap = false;
  const core = { exports: { memory, bun_memory_telemetry: () => 128 } };
  const side = { exports: {
    [`${engine}_memory_telemetry`]: () => 256,
    [`${engine}_memory_telemetry_refresh`]: () => {
      refreshes++;
      if (trap) throw new WebAssembly.RuntimeError("unreachable");
      put(256, engine === "jsc" ? 3 : 4, 3000n);
      return 256;
    },
  } };
  return { memory, core, side, put, reader: createMemoryReader(engine, core, side, LIMIT_BYTES), refreshes: () => refreshes, trap: () => { trap = true; } };
}

test("normal JSC refresh preserves overlapping estimates, unknowns, and the exact 192-byte ABI", () => {
  const f = fixture("jsc");
  f.put(256, 6, 1000n); f.put(256, 23, 8192n);
  const sample = f.reader.sample(true);
  expect(sample.allocatorLiveBytes).toBe(10000);
  expect(sample.allocatorPeakBytes).toBe(20000);
  expect(sample.memoryLimitBytes).toBe(LIMIT_BYTES);
  expect(sample.jsHeapBytes).toBe(3000);
  expect(sample.arrayBufferBytes).toBeNull();
  expect(sample.swcBytes).toBeNull();
  expect(sample.engineCounters.gcAccountedArrayBufferBytes).toBe(1000);
  expect(sample.engineCounters.allocationBudgetThisCycle).toBe(8192);
  expect(sample.engineCounters.heapAfterLastFullCollectionBytes).toBeNull();
  f.put(256, 1, 184n);
  expect(() => f.reader.sample()).toThrow("ABI");
});

test("latched engine or allocator failure never refreshes a faulted guest", () => {
  for (const engine of ["jsc", "quickjs"] as const) {
    const f = fixture(engine);
    f.reader.sample(true);
    f.put(256, engine === "jsc" ? 20 : 8, 123456n);
    f.put(256, engine === "jsc" ? 21 : 9, 1n);
    f.trap();
    const failed = f.reader.sample(true);
    expect(failed.failedAllocation?.bytes).toBe(123456);
    expect(failed.jsHeapBytes).toBe(3000);
    expect(f.refreshes()).toBe(1);
    expect(f.reader.finish().terminal).toBe(true);
    f.reader.sample(true);
    expect(f.refreshes()).toBe(1);
  }
  const f = fixture("jsc");
  f.put(128, 4, 0xffffffffffffffffn); f.put(128, 5, 2n);
  expect(f.reader.sample(true).allocatorFailure).toEqual({ bytes: null, category: "libc.calloc" });
  expect(f.refreshes()).toBe(0);
});

test("a refresh trap disables all subsequent refreshes and cached reading survives memory growth", () => {
  const f = fixture("quickjs");
  f.trap();
  expect(() => f.reader.sample(true)).toThrow("unreachable");
  f.memory.grow(1);
  expect(f.reader.sample(true).wasmCapacityBytes).toBe(131072);
  expect(f.refreshes()).toBe(1);
  expect(f.reader.finish().terminal).toBe(true);
});

test("QuickJS backing stores, first failure and unknown values retain their separate meanings", () => {
  const f = fixture("quickjs");
  f.put(256, 3, 6000n); f.put(256, 5, 2048n); f.put(256, 6, 2n); f.put(256, 11, 1n);
  const value = f.reader.sample(true);
  expect(value.arrayBufferBytes).toBe(2048);
  expect(value.engineCounters.mallocBytes).toBe(6000);
  expect(value.engineCounters.arrayBufferCount).toBe(2);
  expect(value.wasmCapacityBytes).toBe(65536);
  expect(value.failedAllocation).toBeNull();
});

test("terminal channel retains bounded validated identities and unknown aggregates cannot pass as zero", () => {
  const f = fixture("quickjs");
  const snapshot = f.reader.finish();
  expect(recordMemorySnapshot({ type: "bun-memory", snapshot })).toBe(true);
  expect(retainedMemorySnapshots().some(value => value.id === snapshot.id)).toBe(true);
  expect(() => recordMemorySnapshot({ type: "bun-memory", snapshot: { id: "invalid" } })).toThrow();
  expect(recordMemorySnapshot({ type: "stdout" })).toBe(false);
  expect(aggregate([snapshot, { ...emptyCounters }]).allocatorLiveBytes).toBeNull();
  expect(aggregate([snapshot, snapshot]).allocatorLiveBytes).toBe(20000);
  expect(aggregate([]).jsHeapBytes).toBeNull();
});

test("an unsampled live process stays unknown rather than inheriting a previous terminal process", () => {
  const id = crypto.randomUUID();
  beginMemorySnapshot("jsc", id);
  const initial = retainedMemorySnapshots().find(snapshot => snapshot.id === id);
  expect(initial?.terminal).toBe(false);
  expect(initial?.allocatorLiveBytes).toBeNull();
  endMemorySnapshot(id);
  expect(retainedMemorySnapshots().find(snapshot => snapshot.id === id)?.terminal).toBe(true);
});

test("an explicit root retains a failed child and excludes unrelated later commands", () => {
  const f = fixture("quickjs");
  const parent = { ...f.reader.sample(), id: "parent", terminal: false,
    lineage: { authority: "runtime-supervisor", runtimeId: "runtime", pid: 10, parentPid: 0, rootId: "parent", rootPid: 10, ancestry: [10] } };
  const failure = { bytes: 629145600, category: "quickjs.arrayBuffer" };
  const child = { ...parent, id: "child", terminal: true, failedAllocation: failure, engineFailure: failure,
    lineage: { ...parent.lineage, pid: 11, parentPid: 10, ancestry: [11, 10] } };
  const unrelated = { ...child, id: "unrelated", commandSequence: 999,
    lineage: { ...parent.lineage, pid: 20, parentPid: 0, rootId: "unrelated", rootPid: 20, ancestry: [20] } };
  const roots = [{ authority: "runtime-supervisor", complete: true, runtimeId: "runtime", rootId: "parent", rootPid: 10,
    members: [{ pid: 10, parentPid: 0, telemetryId: "parent", terminal: false }, { pid: 11, parentPid: 10, telemetryId: "child", terminal: true }] }];
  const value = selectMemorySnapshots([unrelated, child, parent], "quickjs", "parent", roots);
  expect(value.attribution.kind).toBe("root");
  expect(value.failedAllocation).toEqual(failure);
  expect(value.failureProcessId).toBe("child");
  expect(value.processes.map(process => process.id)).toEqual(["unrelated", "child", "parent"]);
  expect(value.attributedProcesses.map(process => process.id)).toEqual(["parent", "child"]);
  expect(value.allocatorLiveBytes).toBe(parent.allocatorLiveBytes);
  expect(value.memoryLimitBytes).toBeNull();
});

test("legacy snapshots retain earlier active build and later terminal processes without inventing ancestry", () => {
  const f = fixture("quickjs");
  const build = { ...f.reader.sample(), id: "build", commandSequence: 2, terminal: false, allocatorLiveBytes: 300000000 };
  const tiny = { ...build, id: "tiny", commandSequence: 5, terminal: true, allocatorLiveBytes: 43664488 };
  const value = selectMemorySnapshots([build, tiny], "quickjs");
  expect(value.attribution.kind).toBe("unknown");
  expect(value.allocatorLiveBytes).toBeNull();
  expect(value.allocatorPeakBytes).toBeNull();
  expect(value.memoryLimitBytes).toBeNull();
  expect(value.rawProcesses).toEqual([build, tiny]);
  expect(value.processes.map(process => process.id)).toEqual(["build", "tiny"]);
  expect(selectMemorySnapshots([build, tiny], "quickjs", "build").attribution.kind).toBe("unknown");
});

test("shared telemetry refreshes only at a normal boundary and preserves cached failure after runtime destruction", () => {
  const f = fixture("quickjs");
  const channel = createMemoryChannel();
  const publisher = createMemoryPublisher(channel, f.reader);
  const generation = requestMemoryChannel(channel, true);
  publisher.capture(false);
  expect(f.refreshes()).toBe(0);
  expect(memoryChannelReady(channel, generation, true)).toBe(false);
  publisher.capture(true);
  expect(f.refreshes()).toBe(1);
  expect(memoryChannelReady(channel, generation, true)).toBe(true);
  f.put(256, 8, 629145600n); f.put(256, 9, 4n);
  publisher.capture(false, true);
  f.put(256, 4, 0xffffffffffffffffn); f.put(256, 9, 0n);
  const terminal = publisher.finish();
  expect(terminal?.engineFailure).toEqual({ bytes: 629145600, category: "quickjs.arrayBuffer" });
  expect(terminal?.jsHeapBytes).toBe(3000);
  expect(f.refreshes()).toBe(1);
  const read: unknown = readMemoryChannel(channel);
  expect(read).toEqual(terminal);
});

test("host import observation distinguishes the two event-loop waits from arbitrary host calls", () => {
  const calls: [boolean, boolean][] = [];
  const imports = { env: { bun_core_idle: () => 0, other: () => 0 }, wasi_snapshot_preview1: { fd_write: () => 0 } };
  const observed = observeMemoryImports(imports, (normal, force) => { calls.push([normal, force]); }, true);
  for (const [namespace, name] of [["env", "bun_core_idle"], ["env", "other"], ["wasi_snapshot_preview1", "fd_write"]]) {
    const call = observed[namespace!]?.[name!];
    if (typeof call !== "function") throw new Error("missing observed import");
    call();
  }
  expect(calls).toEqual([[true, false], [false, false], [false, true]]);
});

test("a late shared frame cannot resurrect a process ended while a phase sample awaits", async () => {
  const f = fixture("quickjs");
  const id = crypto.randomUUID();
  const transport = beginMemorySnapshot("quickjs", id);
  if (!transport) throw new Error("missing shared transport");
  const publisher = createMemoryPublisher(transport.buffer, createMemoryReader("quickjs", f.core, f.side, LIMIT_BYTES, transport));
  publisher.capture(false, true);
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") throw new Error("missing host sampler");
  const pending: unknown = getter("quickjs", true);
  endMemorySnapshot(id);
  await pending;
  expect(retainedMemorySnapshots().find(snapshot => snapshot.id === id)?.terminal).toBe(true);
  expect(f.refreshes()).toBe(0);
});

test("a late frame cannot replace a new command record using the same diagnostic id", async () => {
  const f = fixture("quickjs");
  const id = crypto.randomUUID();
  const transport = beginMemorySnapshot("quickjs", id, "old-record");
  if (!transport) throw new Error("missing shared transport");
  createMemoryPublisher(transport.buffer, createMemoryReader("quickjs", f.core, f.side, LIMIT_BYTES, transport)).capture(false, true);
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") throw new Error("missing host sampler");
  const pending: unknown = getter("quickjs", true);
  beginMemorySnapshot("quickjs", id, "new-record");
  await pending;
  expect(retainedMemorySnapshots().find(snapshot => snapshot.id === id)?.commandId).toBe("new-record");
  endMemorySnapshot(id);
});

test("clock ties never choose an aggregate scope without a caller root", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1234);
  const f = fixture("quickjs");
  const old = beginMemorySnapshot("quickjs", crypto.randomUUID());
  const currentId = crypto.randomUUID();
  try {
    if (!old) throw new Error("missing shared transport");
    const oldSnapshot = createMemoryReader("quickjs", f.core, f.side, LIMIT_BYTES, old).finish();
    recordMemorySnapshot({ type: "bun-memory", snapshot: { ...oldSnapshot, failedAllocation: { bytes: 1, category: "old" } } });
    endMemorySnapshot(old.id);
    beginMemorySnapshot("quickjs", currentId);
    const selected = selectMemorySnapshots(retainedMemorySnapshots(), "quickjs");
    expect(selected.failedAllocation).toBeNull();
    expect(selected.attribution.kind).toBe("unknown");
    expect(selected.allocatorLiveBytes).toBeNull();
    expect(selected.processes.some(process => process.id === currentId)).toBe(true);
  } finally { clock.mockRestore(); endMemorySnapshot(currentId); }
});

test("a root scope with a missing opaque member or a broken parent edge stays unknown", () => {
  const f = fixture("quickjs");
  const root = { ...f.reader.sample(), id: "root" };
  const inventory = { authority: "runtime-supervisor", complete: true, runtimeId: "runtime", rootId: "root", rootPid: 1,
    members: [{ pid: 1, parentPid: 0, telemetryId: "root", terminal: false }, { pid: 2, parentPid: 1, telemetryId: null, terminal: false }] };
  expect(selectMemorySnapshots([root], "quickjs", "root", [inventory]).attribution.kind).toBe("unknown");
  const broken = { ...inventory, members: [{ pid: 1, parentPid: 0, telemetryId: "root", terminal: false }, { pid: 2, parentPid: 3, telemetryId: "child", terminal: false }] };
  expect(selectMemorySnapshots([root, { ...root, id: "child" }], "quickjs", "root", [broken]).attribution.kind).toBe("unknown");
});
