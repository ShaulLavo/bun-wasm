import { expect, spyOn, test } from "bun:test";
import { beginMemorySnapshot, createMemoryReader, emptyCounters, endMemorySnapshot, recordMemorySnapshot, retainedMemorySnapshots,
  registerMemoryProcess, observeMemoryOutcome, memoryRuntimeId, memoryCommandId, retainedMemoryProcesses, memoryObservationLimits, type MemorySnapshot } from "../web/src/memory-telemetry.ts";
import { createMemoryChannel, createMemoryPublisher, memoryChannelReady, observeMemoryImports, readMemoryChannel, requestMemoryChannel } from "../web/src/memory-channel.ts";
import { aggregate, selectMemorySnapshots } from "./app-matrix/engine-memory-hook.ts";
import type { ProcessService } from "waffle";

// Passed through as the core's declared maximum; any page multiple shows it is not a constant.
const LIMIT_BYTES = 7 * 65536;

function fixture(engine: "jsc" | "quickjs") {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const put = (base: number, index: number, value: bigint) => view.setBigUint64(base + index * 8, value, true);
  for (let index = 0; index < 24; index++) put(256, index, 0xffffffffffffffffn);
  put(128, 0, 1n); put(128, 1, 80n); put(128, 2, 10000n); put(128, 3, 20000n); put(128, 5, 0n);
  put(256, 0, 1n); put(256, 1, engine === "jsc" ? 192n : 128n); put(256, 2, 1n);
  put(256, engine === "jsc" ? 21 : 9, 0n);
  if (engine === "quickjs") {
    put(256, 12, 0n); put(256, 13, 5000n); put(256, 14, 10000n); put(256, 15, 6000n);
  }
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
  f.put(256, 12, 3n); f.put(256, 13, 5000n); f.put(256, 14, 10000n); f.put(256, 15, 6000n);
  const value = f.reader.sample(true);
  expect(value.arrayBufferBytes).toBe(2048);
  expect(value.engineCounters.mallocBytes).toBe(6000);
  expect(value.engineCounters.arrayBufferCount).toBe(2);
  expect(value.engineCounters.automaticGcCount).toBe(3);
  expect(value.engineCounters.mallocBytesAfterAutomaticGc).toBe(5000);
  expect(value.engineCounters.mallocGcThreshold).toBe(10000);
  expect(value.engineCounters.currentMallocBytes).toBe(6000);
  expect(value.wasmCapacityBytes).toBe(65536);
  expect(value.failedAllocation).toBeNull();
});

test("terminal channel retains bounded validated identities and unknown aggregates cannot pass as zero", () => {
  const f = fixture("quickjs");
  const transport = beginMemorySnapshot("quickjs", crypto.randomUUID());
  if (!transport) throw Error("missing transport");
  const snapshot = createMemoryReader("quickjs", f.core, f.side, LIMIT_BYTES, transport).finish();
  expect(recordMemorySnapshot({ type: "bun-memory", snapshot })).toBe(true);
  expect(retainedMemorySnapshots().some(value => value.id === snapshot.id)).toBe(true);
  expect(() => recordMemorySnapshot({ type: "bun-memory", snapshot: { id: "invalid" } }, transport.id)).not.toThrow();
  expect(recordMemorySnapshot({ type: "stdout" })).toBe(false);
  expect(aggregate([snapshot, { ...emptyCounters }]).allocatorLiveBytes).toBeNull();
  expect(aggregate([snapshot, snapshot]).allocatorLiveBytes).toBe(20000);
  expect(aggregate([]).jsHeapBytes).toBeNull();
  endMemorySnapshot(transport.id);
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

test("functions the linker bound from another module keep their direct calls, except the two waits", () => {
  const calls: [boolean, boolean][] = [];
  const linked = { env: { malloc: () => 0, bun_core_idle: () => 0, bun_core_poll: () => 0 } };
  const imports = { env: { ...linked.env, host: () => 0 }, wasi_snapshot_preview1: { fd_write: () => 0 } };
  const observed = observeMemoryImports(imports, (normal, force) => { calls.push([normal, force]); }, true, linked);
  expect(observed.env?.malloc).toBe(linked.env.malloc);
  for (const [namespace, name] of [["env", "malloc"], ["env", "bun_core_idle"], ["env", "bun_core_poll"], ["env", "host"], ["wasi_snapshot_preview1", "fd_write"]]) {
    const call = observed[namespace!]?.[name!];
    if (typeof call !== "function") throw new Error("missing observed import");
    call();
  }
  expect(calls).toEqual([[true, false], [true, false], [false, false], [false, true]]);
});

test("a host function replacing a linked name is still observed", () => {
  const calls: [boolean, boolean][] = [];
  const linked = { env: { malloc: () => 0 } };
  const observed = observeMemoryImports({ env: { malloc: () => 1 } }, (normal, force) => { calls.push([normal, force]); }, true, linked);
  const call = observed.env?.malloc;
  if (typeof call !== "function") throw new Error("missing observed import");
  expect(call()).toBe(1);
  expect(calls).toEqual([[false, false]]);
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

function frozenFixture(limitBytes: number | null = LIMIT_BYTES) {
  const f = fixture("quickjs");
  for (let index = 0; index < 9; index++) f.put(512, index, 0xffffffffffffffffn);
  f.put(512, 0, 1n); f.put(512, 1, 72n); f.put(512, 3, 0n);
  const core = { exports: { ...f.core.exports, bun_memory_failure_telemetry: () => 512 } };
  return { ...f, core, reader: createMemoryReader("quickjs", core, f.side, limitBytes) };
}

function latchFrozen(f: ReturnType<typeof frozenFixture>) {
  [1n, 72n, 100000n, 3n, 40012n, 80024n, 160048n, 196608n, 196608n]
    .forEach((value, index) => f.put(512, index, value));
}

test("frozen allocator state is cached separately from current allocator and engine failures", () => {
  const f = frozenFixture();
  expect(f.reader.sample().frozenAllocatorFailure).toBeNull();
  latchFrozen(f);
  f.put(128, 4, 100000n); f.put(128, 5, 3n);
  f.put(256, 8, 99999n); f.put(256, 9, 3n);
  f.trap();
  const snapshot = f.reader.sample(true);
  expect(snapshot.frozenAllocatorFailure).toEqual({ bytes: 100000, category: "libc.realloc",
    previousUsableBytes: 40012, allocatorLiveBytes: 80024, allocatorPeakBytes: 160048,
    wasmCapacityBeforeBytes: 196608, wasmCapacityAfterBytes: 196608, reason: "unknown" });
  expect(snapshot.allocatorFailure).toEqual({ bytes: 100000, category: "libc.realloc" });
  expect(snapshot.engineFailure).toEqual({ bytes: 99999, category: "quickjs.realloc" });
  expect(snapshot.allocatorLiveBytes).toBe(10000);
  expect(snapshot.memoryLimitBytes).toBe(LIMIT_BYTES);
  expect(f.refreshes()).toBe(0);
  f.memory.grow(1);
  const terminal = f.reader.finish();
  expect(terminal.wasmCapacityBytes).toBe(2 * 65536);
  expect(terminal.memoryLimitBytes).toBe(LIMIT_BYTES);
  expect(terminal.frozenAllocatorFailure).toEqual(snapshot.frozenAllocatorFailure);
  const canonical = selectMemorySnapshots([snapshot], "quickjs");
  expect(canonical.allocatorLiveBytes).toBeNull();
  expect(canonical.attribution.kind).toBe("unknown");
  expect(canonical.rawProcesses).toEqual([snapshot]);
});

test("frozen capacity cannot establish an unknown declared memory maximum", () => {
  const f = frozenFixture(null);
  latchFrozen(f);
  const snapshot = f.reader.sample();
  expect(snapshot.memoryLimitBytes).toBeNull();
  expect(snapshot.frozenAllocatorFailure?.wasmCapacityAfterBytes).toBe(196608);
  expect(snapshot.wasmCapacityBytes).toBe(65536);
});

test("frozen unknown and unsafe u64 values stay null without a rejection reason", () => {
  const f = frozenFixture();
  latchFrozen(f);
  f.put(512, 2, 0xffffffffffffffffn); f.put(512, 3, 999n);
  f.put(512, 4, 9007199254740992n); f.put(512, 5, 0n);
  f.put(512, 6, 9007199254740991n); f.put(512, 7, 0xffffffffffffffffn);
  expect(f.reader.sample().frozenAllocatorFailure).toEqual({ bytes: null, category: "unknown.999",
    previousUsableBytes: null, allocatorLiveBytes: 0, allocatorPeakBytes: Number.MAX_SAFE_INTEGER,
    wasmCapacityBeforeBytes: null, wasmCapacityAfterBytes: 196608, reason: "unknown" });
  expect(f.reader.sample(true).engineFailure).toBeNull();
  expect(f.refreshes()).toBe(0);
  expect(fixture("quickjs").reader.sample().frozenAllocatorFailure).toBeNull();
});

test("frozen reader rejects unsupported ABI and malformed pointers without wrapping them", () => {
  const f = frozenFixture();
  f.put(512, 0, 2n);
  expect(() => f.reader.sample()).toThrow("ABI");
  f.put(512, 0, 1n); f.put(512, 1, 80n);
  expect(() => f.reader.sample()).toThrow("ABI");
  for (const pointer of [0, -1, -2147483649, 4294967808, 512.5, NaN, Infinity, 516, 65528]) {
    const core = { exports: { ...f.core.exports, bun_memory_failure_telemetry: () => pointer } };
    expect(() => createMemoryReader("quickjs", core, f.side, LIMIT_BYTES).sample()).toThrow();
  }
});

test("frozen record survives channel teardown and validates at the host boundary", () => {
  const f = frozenFixture();
  latchFrozen(f);
  const transport = beginMemorySnapshot("quickjs", crypto.randomUUID());
  if (!transport) throw new Error("missing shared transport");
  const reader = createMemoryReader("quickjs", f.core, f.side, LIMIT_BYTES, transport);
  let disposed = false;
  const publisher = createMemoryPublisher(transport.buffer, {
    sample: (refresh) => reader.sample(refresh),
    finish: () => ({ ...reader.finish(), frozenAllocatorFailure: disposed ? null : reader.sample().frozenAllocatorFailure }),
  });
  try {
    const initial = publisher.capture(false, true);
    expect(initial?.id).toBe(transport.id);
    expect(initial?.commandId).toBe(transport.commandId);
    expect(initial?.commandSequence).toBe(transport.commandSequence);
    expect(initial?.memoryLimitBytes).toBe(LIMIT_BYTES);
    f.put(256, 8, 99999n); f.put(256, 9, 3n);
    publisher.capture(false, true);
    disposed = true;
    const terminal = publisher.finish();
    expect(terminal?.id).toBe(transport.id);
    expect(terminal?.memoryLimitBytes).toBe(LIMIT_BYTES);
    expect(terminal?.frozenAllocatorFailure).toEqual(initial?.frozenAllocatorFailure);
    expect(terminal?.engineFailure).toEqual({ bytes: 99999, category: "quickjs.realloc" });
    expect(readMemoryChannel(transport.buffer)).toEqual(terminal);
    expect(recordMemorySnapshot({ type: "bun-memory", snapshot: terminal })).toBe(true);
    for (const invalid of [undefined, {}, { ...initial?.frozenAllocatorFailure, reason: "limit" },
      { ...initial?.frozenAllocatorFailure, previousUsableBytes: -1 },
      { ...initial?.frozenAllocatorFailure, bytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => recordMemorySnapshot({ type: "bun-memory", snapshot: { ...terminal, frozenAllocatorFailure: invalid } }, transport.id)).not.toThrow();
      expect(retainedMemoryProcesses().processes.find(row => row.id === transport.id)?.status).toBe("invalid");
    }
  } finally { endMemorySnapshot(transport.id); }
  expect(retainedMemorySnapshots().find(value => value.id === transport.id)?.frozenAllocatorFailure)
    .toEqual(f.reader.sample().frozenAllocatorFailure);
});

function observationFixture(pid = 101, runtime = { disposed: false }, service: Pick<ProcessService, "workerMemory"> = { workerMemory: () => [
  { pid, parentPid: 1, rootPid: 1, job: 7, directory: `synthetic-directory-${pid}`, bytes: 65536 },
] }) {
  const f = frozenFixture();
  const id = crypto.randomUUID();
  registerMemoryProcess("spidermonkey", id, runtime, { pid, parentPid: 1, job: 7 }, service);
  const transport = beginMemorySnapshot("spidermonkey", id, memoryCommandId(runtime, 7));
  if (!transport) throw Error("missing synthetic transport");
  const reader = createMemoryReader("spidermonkey", f.core, undefined, LIMIT_BYTES, transport);
  const publisher = createMemoryPublisher(transport.buffer, reader);
  return { ...f, id, runtime, service, transport, reader, publisher };
}
function processObservation(id: string) {
  const row = retainedMemoryProcesses().processes.find(row => row.id === id);
  if (!row) throw Error(`missing test process ${id}`);
  return row;
}
const cleanExit = () => ({ kind: "exited", code: 0, status: 0 } as const);
function writeSyntheticFrame(buffer: SharedArrayBuffer, value: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  new Uint8Array(buffer, 32, bytes.length).set(bytes);
  Atomics.store(new Int32Array(buffer), 4, bytes.length);
}

test("launcher-entry identity covers setup failure without inventing a sample or runtime activation", () => {
  const runtime = { disposed: false, processes() { throw Error("must not activate"); } };
  const service = { workerMemory: () => [] };
  const id = crypto.randomUUID();
  registerMemoryProcess("spidermonkey", id, runtime, { pid: 8, parentPid: 7, job: 6 }, service);
  expect(processObservation(id)).toMatchObject({ binding: { runtimeId: memoryRuntimeId(runtime), pid: 8, parentPid: 7, job: 6 }, sample: null, endedAt: null });
  endMemorySnapshot(id, () => ({ kind: "start-failed", error: "ENOMEM", code: 12, status: null }));
  expect(processObservation(id)).toMatchObject({ status: "missing", outcome: { kind: "observed", value: { kind: "start-failed", error: "ENOMEM", code: 12, status: null } } });
});
test("unbound runner-style roots stay unbound and both export/read facts are needed", () => {
  const f = frozenFixture();
  const transport = beginMemorySnapshot("spidermonkey", crypto.randomUUID());
  if (!transport) throw Error("missing transport");
  const reader = createMemoryReader("spidermonkey", f.core, undefined, LIMIT_BYTES, transport);
  createMemoryPublisher(transport.buffer, reader).finish();
  endMemorySnapshot(transport.id);
  expect(processObservation(transport.id)).toMatchObject({ binding: null, sample: { libcTelemetry: { allocator: "read", failure: "read" } } });
  const unsupported = createMemoryReader("spidermonkey", f.core, undefined, LIMIT_BYTES);
  const ordinary = fixture("quickjs");
  expect(unsupported.sample().libcTelemetry?.failure).toBe("read");
  expect(ordinary.reader.sample().libcTelemetry).toEqual({ allocator: "read", failure: "unsupported" });
});
test.each(["length", "json", "shape"])("corrupt %s channel is nonthrowing, detached and terminal", kind => {
  const f = observationFixture();
  if (kind === "length") Atomics.store(new Int32Array(f.transport.buffer), 4, f.transport.buffer.byteLength);
  if (kind === "json") { new Uint8Array(f.transport.buffer)[32] = 123; Atomics.store(new Int32Array(f.transport.buffer), 4, 1); }
  if (kind === "shape") writeSyntheticFrame(f.transport.buffer, { id: f.id });
  expect(() => endMemorySnapshot(f.id, cleanExit)).not.toThrow();
  const before = processObservation(f.id);
  expect(before.status).toBe(kind === "shape" ? "invalid" : "read-failed");
  expect(before.endedAt).not.toBeNull();
  f.publisher.finish();
  endMemorySnapshot(f.id, () => { throw Error("idempotent cleanup must not read twice"); });
  expect(processObservation(f.id)).toEqual(before);
});
test.each(["id", "commandId", "engine", "commandSequence", "incarnation"])("terminal channel validates %s before accepting a frame", field => {
  const f = observationFixture();
  const value: MemorySnapshot = { ...f.reader.finish() };
  const invalid = field === "commandSequence" ? value.commandSequence + 1 : field === "incarnation" ? (value.incarnation ?? 0) + 1 : "wrong-identity";
  Reflect.set(value, field, invalid);
  writeSyntheticFrame(f.transport.buffer, value);
  endMemorySnapshot(f.id, cleanExit);
  expect(processObservation(f.id)).toMatchObject({ status: "invalid", sample: null });
});
test("a reused telemetry ID and command still reject frames from the earlier incarnation", () => {
  const f = observationFixture();
  const old = f.reader.finish();
  endMemorySnapshot(f.id, cleanExit);
  beginMemorySnapshot("spidermonkey", f.id, f.transport.commandId);
  recordMemorySnapshot({ type: "bun-memory", snapshot: old }, f.id);
  expect(processObservation(f.id)).toMatchObject({ status: "invalid", sample: null });
  endMemorySnapshot(f.id);
});
test("late posted frames cannot reopen terminal rows, poison another identity or populate unregistered rows", () => {
  const f = observationFixture();
  f.publisher.finish();
  endMemorySnapshot(f.id, cleanExit);
  const before = processObservation(f.id);
  recordMemorySnapshot({ type: "bun-memory", snapshot: { ...f.reader.sample(), terminal: false } }, f.id);
  recordMemorySnapshot({ type: "bun-memory", snapshot: { ...f.reader.sample(), id: crypto.randomUUID() } });
  expect(processObservation(f.id)).toEqual(before);
  expect(retainedMemorySnapshots().find(row => row.id === f.id)?.terminal).toBe(true);
});
test("outcome null, failed reads, signals and exited 134 remain distinct", () => {
  const reads = [() => null, () => { throw Error("collected incarnation"); },
    () => ({ kind: "signaled", code: 9, status: 137 } as const), () => ({ kind: "exited", code: 134, status: 134 } as const)];
  const outcomes = reads.map(read => {
    const f = observationFixture();
    f.publisher.finish();
    endMemorySnapshot(f.id, read);
    return processObservation(f.id).outcome;
  });
  expect(outcomes).toEqual([{ kind: "observed", value: null }, { kind: "unavailable", reason: "read-failed" },
    { kind: "observed", value: { kind: "signaled", code: 9, status: 137 } }, { kind: "observed", value: { kind: "exited", code: 134, status: 134 } }]);
});
test("revocation retains a protected typed outcome before collection without rereading it at cleanup", () => {
  const f = observationFixture();
  const exit = { kind: "exited", code: 70, status: 70 } as const;
  observeMemoryOutcome(f.id, () => exit);
  f.publisher.finish();
  let lateReads = 0;
  endMemorySnapshot(f.id, () => { lateReads++; throw Error("incarnation collected"); });
  observeMemoryOutcome(f.id, () => { lateReads++; throw Error("late revocation"); });
  expect(lateReads).toBe(0);
  expect(processObservation(f.id)).toMatchObject({ outcome: { kind: "observed", value: exit }, outcomeBoundary: "revocation" });
});
test("an early null outcome is distinct from a later failed read and never becomes a selected exit", () => {
  const f = observationFixture();
  observeMemoryOutcome(f.id, () => null);
  expect(processObservation(f.id)).toMatchObject({ outcome: { kind: "observed", value: null }, outcomeBoundary: "revocation" });
  endMemorySnapshot(f.id, () => { throw Error("incarnation collected"); });
  expect(processObservation(f.id)).toMatchObject({ outcome: { kind: "unavailable", reason: "read-failed" }, outcomeBoundary: "adapter-cleanup" });
});
test("concurrent runtime/PID joins preserve directory, trigger sequence and known subtotals", async () => {
  const first = observationFixture(12), second = observationFixture(12);
  first.publisher.finish(); second.publisher.finish();
  await Promise.all([first, second].map(async f => { endMemorySnapshot(f.id, () => ({ kind: "signaled", code: 9, status: 137 })); }));
  const result = retainedMemoryProcesses();
  const rows = result.censuses.filter(row => row.telemetryId === first.id || row.telemetryId === second.id);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(row => row.runtimeId)).size).toBe(2);
  expect(rows[0]?.sequence).not.toBe(rows[1]?.sequence);
  for (const row of rows) expect(row).toMatchObject({ boundary: "adapter-cleanup", state: "observed", knownSampledBytesSubtotal: 65536,
    aliasing: "uncertain", workers: [{ pid: 12, parentPid: 1, rootPid: 1, directory: "synthetic-directory-12", engine: "spidermonkey", bytes: 65536 }] });
});
test("getter never requests, refreshes or reactivates; disposed and failed service reads preserve terminal samples", () => {
  let reads = 0;
  const runtime = { disposed: false };
  const service = { workerMemory() { reads++; throw Error("private collection context"); } };
  const f = observationFixture(12, runtime, service);
  f.publisher.finish();
  endMemorySnapshot(f.id, cleanExit);
  const words = new Int32Array(f.transport.buffer);
  const generation = Atomics.load(words, 0);
  expect(retainedMemoryProcesses().runtimes.find(row => row.runtimeId === memoryRuntimeId(runtime))?.state).toBe("read-failed");
  const before = reads;
  runtime.disposed = true;
  const result = retainedMemoryProcesses();
  expect(result.runtimes.find(row => row.runtimeId === memoryRuntimeId(runtime))?.state).toBe("disposed");
  expect(reads).toBe(before);
  expect(Atomics.load(words, 0)).toBe(generation);
  expect(processObservation(f.id).sample?.terminal).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private collection context");
  const copy = result.processes.find(row => row.id === f.id);
  if (copy?.binding) copy.binding.pid = 999;
  expect(processObservation(f.id).binding?.pid).toBe(12);
});
test("weak service/runtime registrations do not keep their owners alive", async () => {
  function register() {
    const runtime = { disposed: false }, service = { workerMemory: () => [] };
    const id = crypto.randomUUID();
    const runtimeId = memoryRuntimeId(runtime);
    registerMemoryProcess("spidermonkey", id, runtime, { pid: 77, parentPid: 1, job: 1 }, service);
    endMemorySnapshot(id, cleanExit);
    return { runtimeId, runtime: new WeakRef(runtime), service: new WeakRef(service) };
  }
  const refs = register();
  await Bun.sleep(0);
  Bun.gc(true);
  expect(refs.runtime.deref()).toBeUndefined();
  expect(refs.service.deref()).toBeUndefined();
  expect(retainedMemoryProcesses().runtimes.find(row => row.runtimeId === refs.runtimeId)?.state).toBe("disposed");
});
test("recent census retention and hard process bounds expose coherent eviction and truncation", () => {
  const before = retainedMemoryProcesses().loss;
  const fixtures = Array.from({ length: memoryObservationLimits.active + 1 }, (_, i) => observationFixture(1000 + i));
  expect(retainedMemoryProcesses().loss.active).toBeGreaterThan(before.active);
  for (const f of fixtures) { f.publisher.finish(); endMemorySnapshot(f.id, () => ({ kind: "exited", code: 70, status: 70 })); }
  const result = retainedMemoryProcesses();
  expect(result.processes.filter(row => row.endedAt !== null).length).toBeLessThanOrEqual(memoryObservationLimits.terminal);
  expect(result.censuses).toHaveLength(memoryObservationLimits.censuses);
  expect(result.censuses.at(-1)?.telemetryId).toBe(fixtures.at(-1)?.id);
  expect(result.loss.censuses).toBeGreaterThan(before.censuses);
  expect(result.loss.terminal).toBeGreaterThan(before.terminal);
  expect(result.loss.runtimes).toBeGreaterThan(before.runtimes);
  expect(result.incomplete).toBe(true);
  const ids = new Set(result.processes.map(row => row.id));
  expect(retainedMemorySnapshots().every(row => ids.has(row.id))).toBe(true);
});
test("worker and serialized output bounds retain explicit loss, unknown bytes and adapter labels", () => {
  const workers = Array.from({ length: memoryObservationLimits.workers + 1 }, (_, i) => ({ pid: i + 1, parentPid: 0, rootPid: 1,
    job: 1, directory: "d".repeat(128), bytes: i % 2 ? null : 65536 }));
  const fixtures = Array.from({ length: memoryObservationLimits.runtimes }, (_, i) => observationFixture(2000 + i, { disposed: false }, { workerMemory: () => workers }));
  for (const f of fixtures) { f.publisher.finish(); endMemorySnapshot(f.id, () => ({ kind: "exited", code: 70, status: 70 })); }
  const result = retainedMemoryProcesses();
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(memoryObservationLimits.outputBytes);
  expect(result.loss.outputCensuses + result.loss.outputWorkerRows).toBeGreaterThan(0);
  expect(result.runtimes.some(row => row.truncated > 0)).toBe(true);
  expect(result.censuses.every(row => row.workers.length <= memoryObservationLimits.workers)).toBe(true);
  expect(result.runtimes.some(row => row.unknownBytes > 0)).toBe(true);
  expect(result.runtimes.flatMap(row => row.workers).every(row => row.engine === null)).toBe(true);
});
test("legacy caller labels cannot expose paths or defeat the bounded observation projection", () => {
  const id = "/private/caller/path".repeat(1000);
  beginMemorySnapshot("spidermonkey", id);
  endMemorySnapshot(id);
  const result = retainedMemoryProcesses();
  expect(result.loss.outputProcesses).toBeGreaterThan(0);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("/private/caller/path");
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(memoryObservationLimits.outputBytes);
});
