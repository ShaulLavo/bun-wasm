import { expect, test } from "bun:test";
import { beginMemorySnapshot, createMemoryReader, emptyCounters, endMemorySnapshot, recordMemorySnapshot, retainedMemorySnapshots } from "../web/src/memory-telemetry.ts";
import { createMemoryChannel, createMemoryPublisher, memoryChannelReady, observeMemoryImports, readMemoryChannel, requestMemoryChannel } from "../web/src/memory-channel.ts";
import { aggregate, selectMemorySnapshots } from "./app-matrix/engine-memory-hook.ts";

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
  return { memory, core, side, put, reader: createMemoryReader(engine, core, side), refreshes: () => refreshes, trap: () => { trap = true; } };
}

test("normal JSC refresh preserves overlapping estimates, unknowns, and the exact 192-byte ABI", () => {
  const f = fixture("jsc");
  f.put(256, 6, 1000n); f.put(256, 23, 8192n);
  const sample = f.reader.sample(true);
  expect(sample.allocatorLiveBytes).toBe(10000);
  expect(sample.allocatorPeakBytes).toBe(20000);
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

test("a current command keeps a failed child while its parent stays live and excludes an older command", () => {
  const f = fixture("quickjs");
  const parent = { ...f.reader.sample(), id: "parent", commandId: "current", commandStartedAt: 2, terminal: false };
  const failure = { bytes: 629145600, category: "quickjs.arrayBuffer" };
  const child = { ...parent, id: "child", terminal: true, failedAllocation: failure, engineFailure: failure };
  const stale = { ...child, id: "old-child", commandId: "old", commandStartedAt: 1, failedAllocation: { bytes: 9, category: "old" } };
  const value = selectMemorySnapshots([stale, child, parent], "quickjs");
  expect(value.failedAllocation).toEqual(failure);
  expect(value.failureProcessId).toBe("child");
  expect(value.processes.map(process => process.id)).toEqual(["child", "parent"]);
  expect(value.allocatorLiveBytes).toBe(parent.allocatorLiveBytes);
  expect(value.memoryLimitBytes).toBeNull();
  expect(aggregate([parent, parent]).memoryLimitBytes).toBeNull();
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
