import { expect, test } from "bun:test";
import { launchFailureFixture } from "../../scripts/fixtures/launch-failure.ts";
import { browserTrapSource } from "../../scripts/fixtures/browser-call-trap.ts";
import { copyLaunchFailure, errorFact, launchFailureFact, maxLaunchFailureBytes } from "../src/launch-failure.ts";
import { beginMemorySnapshot, endMemorySnapshot, publishBrowserCallTrap, recordLaunchFailure, recordMemorySnapshot, retainedMemorySnapshots, retainedMemoryProcesses, type FrozenAllocatorFailure } from "../src/memory-telemetry.ts";
import { createMemoryPublisher } from "../src/memory-channel.ts";
import { bytes, pages, type SharedMemorySnapshot } from "waffle";

type Holder = SharedMemorySnapshot["holders"][number];

function captureHolders(holders: readonly Holder[]) {
  const fixture = launchFailureFixture();
  fixture.runtime.sharedMemory.snapshot = () => ({ ...fixture.ledger, holders });
  return fixture.capture();
}

function holder(shape: Holder["shape"], label: Holder["label"], state: Holder["state"] = "live"): Holder {
  return { label, shape, state, scope: "runtime", declaredBytes: 16, grownBytes: 16 };
}

test("all ledger holders contribute before detail rows are truncated", () => {
  const arenas = Array.from({ length: 60 }, () => holder({ kind: "growable-buffer", initial: 0, maximum: bytes(134316032) }, "request-arena"));
  const holders = arenas.concat([
    holder({ kind: "growable", maximumPages: pages(32768) }, "memory-group"),
    holder({ kind: "growable", maximumPages: pages(32768) }, "memory-group", "awaiting-collection"),
    holder({ kind: "fixed", pages: pages(2) }, "memory-group", "idle"),
    holder({ kind: "growable-buffer", initial: 16, maximum: bytes(256) }, "pipe-registry"),
    holder({ kind: "fixed-buffer", length: bytes(16) }, "filesystem-root"),
    holder({ kind: "capacity-promise", bytes: bytes(1593835520) }, "filesystem-segment"),
    holder({ kind: "growable", maximumPages: pages(32768) }, "headroom"),
  ]);
  const fact = captureHolders(holders);
  expect(fact.ledger.holders).toMatchObject({ rowCount: 67, rowsTruncated: true });
  expect(fact.ledger.holderSummary).toMatchObject({ availability: "observed", rowCount: 67,
    unknownShapeCount: 0, unknownStateCount: 0, requestArenaActivity: "unavailable" });
  const summary = fact.ledger.holderSummary;
  if (summary.availability !== "observed") throw Error("Missing aggregate");
  expect(summary.kinds.find(row => row.kind === "request-arena")).toMatchObject({ count: 60, maximumBytes: 8058961920, knownCurrentBytes: 960, states: { live: 60, idle: 0 } });
  expect(summary.kinds.find(row => row.kind === "group-growable")).toMatchObject({ count: 2, maximumBytes: 4294967296, states: { live: 1, "awaiting-collection": 1 } });
  expect(summary.kinds.find(row => row.kind === "group-fixed")).toMatchObject({ count: 1, maximumBytes: 131072, states: { idle: 1 } });
  expect(summary.kinds.find(row => row.kind === "growable-buffer")).toMatchObject({ count: 1, maximumBytes: 256 });
  expect(summary.kinds.find(row => row.kind === "fixed-buffer")).toMatchObject({ count: 1, maximumBytes: 16 });
  expect(summary.kinds.find(row => row.kind === "capacity-promise")).toMatchObject({ count: 1, maximumBytes: null, knownCurrentBytes: null });
  expect(summary.kinds.find(row => row.kind === "headroom")).toMatchObject({ count: 1, maximumBytes: null, knownCurrentBytes: null });
  const copy = copyLaunchFailure(fact);
  expect(copy).toEqual(fact);
  summary.kinds[0]!.count = 0;
  summary.kinds[0]!.states.live = 0;
  const retained = copy?.ledger.holderSummary;
  if (retained?.availability !== "observed") throw Error("Missing copied aggregate");
  expect(retained.kinds.find(row => row.kind === "request-arena")).toMatchObject({ count: 60, states: { live: 60 } });
});

test("shared alias metadata and guest declarations do not multiply backing counts", () => {
  const shared = holder({ kind: "shared-guest", initialPages: pages(1), actualMaximumPages: pages(8), sourceMaximumPages: pages(8) }, "guest-memory");
  const declaration = holder({ kind: "guest", memories: [{ kind: "shared", origin: "imported", initialPages: pages(1), maximumPages: pages(8) }] }, "guest-memory");
  const fixture = launchFailureFixture();
  fixture.runtime.sharedMemory.snapshot = () => ({ ...fixture.ledger, holders: [shared, declaration], sharedGuests: [{
    id: Symbol("backing"), owner: { directory: "control", pid: 1 }, phase: "live", aliases: { reserved: 0, transferred: 4, retained: 0 },
    continuations: { active: 0, retained: 0 }, fence: "pending", chargedBytes: 524288,
    initialPages: pages(1), actualMaximumPages: pages(8), sourceMaximumPages: pages(8),
  }] });
  const summary = fixture.capture().ledger.holderSummary;
  if (summary.availability !== "observed") throw Error("Missing aggregate");
  expect(summary.kinds.find(row => row.kind === "shared-guest")).toMatchObject({ count: 1, maximumBytes: 524288 });
  expect(summary.kinds.find(row => row.kind === "guest-declaration")).toMatchObject({ count: 1, maximumBytes: null, knownCurrentBytes: null });
  const independent = captureHolders([shared, shared]).ledger.holderSummary;
  expect(independent).toMatchObject({ kinds: [{ kind: "shared-guest", count: 2, maximumBytes: 1048576 }] });
});

test("unknown and malformed aggregate facts stay explicit without invoking accessors", () => {
  let reads = 0;
  const shape = { kind: "fixed-buffer", length: bytes(16) } as const;
  Object.defineProperty(shape, "length", { get() { reads++; throw Error("size getter"); } });
  const unknown = holder(shape, "control");
  Object.defineProperty(unknown, "state", { get() { reads++; throw Error("state getter"); } });
  Object.defineProperty(unknown, "grownBytes", { value: -1 });
  const invalidShape = holder({ kind: "fixed-buffer", length: bytes(16) }, "control");
  Object.defineProperty(invalidShape, "shape", { get() { reads++; throw Error("shape getter"); } });
  const invalidSize = holder({ kind: "fixed-buffer", length: bytes(16) }, "control");
  Object.defineProperty(invalidSize, "declaredBytes", { value: Infinity });
  const summary = captureHolders([unknown, invalidShape, invalidSize]).ledger.holderSummary;
  expect(reads).toBe(0);
  expect(summary).toMatchObject({ availability: "observed", rowCount: 3, unknownShapeCount: 1, unknownStateCount: 1 });
  if (summary.availability !== "observed") throw Error("Missing aggregate");
  expect(summary.kinds.find(row => row.kind === "fixed-buffer")).toMatchObject({ count: 2, maximumBytes: null, declaredBytes: null,
    knownCurrentBytes: 16, unknownCurrentCount: 1, states: { unknown: 1 } });
  expect(summary.kinds.find(row => row.kind === "unknown")).toMatchObject({ count: 1, maximumBytes: null, knownCurrentBytes: null });
});

test("empty, unavailable and overflowed ledger aggregates remain distinct", () => {
  expect(captureHolders([]).ledger.holderSummary).toMatchObject({ availability: "observed", rowCount: 0, kinds: [] });
  const fixture = launchFailureFixture();
  fixture.runtime.sharedMemory.snapshot = () => { throw Error("unavailable"); };
  expect(fixture.capture().ledger.holderSummary).toEqual({ availability: "unavailable" });
  const large = holder({ kind: "fixed-buffer", length: bytes(Number.MAX_SAFE_INTEGER) }, "control");
  Object.defineProperty(large, "declaredBytes", { value: Number.MAX_SAFE_INTEGER });
  Object.defineProperty(large, "grownBytes", { value: Number.MAX_SAFE_INTEGER });
  expect(captureHolders([large, large]).ledger.holderSummary).toMatchObject({ kinds: [{ count: 2,
    declaredBytes: null, maximumBytes: null, knownCurrentBytes: null }] });
});

test("maximum diagnostic text and every aggregate category fit the unchanged serialized bound", () => {
  const fixture = launchFailureFixture(100);
  const shapes = [holder({ kind: "fixed-buffer", length: bytes(16) }, "control"),
    holder({ kind: "growable-buffer", initial: 0, maximum: bytes(16) }, "request-arena"),
    holder({ kind: "growable-buffer", initial: 0, maximum: bytes(16) }, "pipe-registry"),
    holder({ kind: "fixed", pages: pages(1) }, "memory-group"),
    holder({ kind: "growable", maximumPages: pages(8) }, "memory-group"),
    holder({ kind: "capacity-promise", bytes: bytes(16) }, "filesystem-segment"),
    holder({ kind: "growable", maximumPages: pages(8) }, "headroom"),
    holder({ kind: "guest", memories: [] }, "guest-memory"),
    holder({ kind: "shared-guest", initialPages: pages(1), actualMaximumPages: pages(8), sourceMaximumPages: pages(8) }, "guest-memory")];
  const unknown = holder({ kind: "fixed-buffer", length: bytes(16) }, "control");
  Object.defineProperty(unknown, "shape", { value: null });
  shapes.push(unknown);
  const states = ["live", "draining", "idle", "awaiting-collection", "debt"] as const;
  fixture.runtime.sharedMemory.snapshot = () => ({ ...fixture.ledger, holders: shapes.flatMap(shape => states.map(state => ({ ...shape, state }))) });
  const text = "ࠀ".repeat(10000);
  fixture.error.message = text;
  fixture.error.name = text;
  fixture.error.stack = text;
  fixture.cause.message = text;
  fixture.cause.name = text;
  fixture.cause.stack = text;
  const fact = fixture.capture();
  fact.cleanupError = errorFact({ name: text, message: text, stack: text });
  const copy = copyLaunchFailure(fact);
  expect(copy).not.toBeNull();
  expect(new TextEncoder().encode(JSON.stringify(copy)).byteLength).toBeLessThanOrEqual(maxLaunchFailureBytes);
  scalarTree(copy);
});

test("bounded scalar copies include admitted identity outside the truncated worker table", () => {
  const fixture = launchFailureFixture(100);
  fixture.error.message = "🟢".repeat(10_000);
  fixture.cause.stack = "🟢".repeat(10_000);
  const fact = fixture.capture();
  expect(fact.process).toMatchObject({ pid: 99, rootPid: 10, directory: "directory-99" });
  expect(fact.groups).toMatchObject({ availability: "observed", rowCount: 100, rowsTruncated: true });
  expect(fact.groups.rows[0]).toMatchObject({ pidCount: 100, pidsTruncated: true });
  expect(fact.workers).toMatchObject({ rowCount: 100, rowsTruncated: true });
  expect(fact.ledger.holders).toMatchObject({ rowCount: 100, rowsTruncated: true });
  expect(fact.ledger.holders.rows[0]).toMatchObject({ "shape.kind": "growable", "shape.maximumPages": 32768, grownBytes: 65536 });
  expect(new TextEncoder().encode(JSON.stringify(fact)).byteLength).toBeLessThan(maxLaunchFailureBytes);
  expect(fact.error.message?.length).toBe(384);
  expect(fact.refusal.cause.stack?.length).toBe(768);
  const detached = copyLaunchFailure(fact);
  expect(detached).toEqual(fact);
  fixture.cause.message = "after cleanup";
  fact.process.pid = 0;
  expect(detached?.process.pid).toBe(99);
  expect(detached?.refusal.cause.message).toBe("original native refusal");
  expect(JSON.stringify(detached)).not.toContain("after cleanup");
  scalarTree(detached);
});

function scalarTree(value: unknown): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  expect(typeof value).toBe("object");
  expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : Object.prototype);
  for (const child of Object.values(Object(value))) scalarTree(child);
}

test("error getters and coercion hooks are not invoked, and snapshot failures stay unavailable", () => {
  let reads = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "message", "stack", "refusal"].map(key => [key, { get() { reads++; throw Error("diagnostic getter"); } }])));
  Object.defineProperty(hostile, Symbol.toPrimitive, { value() { reads++; throw Error("coercion"); } });
  expect(errorFact(hostile)).toEqual({ name: null, message: null, stack: null });
  const fixture = launchFailureFixture();
  const fact = launchFailureFact(hostile, fixture.context, {
    memoryGroups() { throw Error("unavailable"); }, workerMemory() { return []; },
  }, { sharedMemory: { snapshot() { throw Error("unavailable"); }, check() { throw Error("not used"); } } }, null, 1);
  expect(reads).toBe(0);
  expect(fact.groups).toMatchObject({ availability: "unavailable", rowCount: null, rowsTruncated: false });
  expect(fact.workers).toMatchObject({ availability: "observed", rowCount: 0, rowsTruncated: false });
  expect(fact.process).toMatchObject({ rootPid: null, directory: null });
  expect(fact.ledger).toMatchObject({ availability: "unavailable", totals: null });
});

test("error facts are copied before snapshot APIs can change their source", () => {
  const fixture = launchFailureFixture();
  fixture.service.memoryGroups = () => { fixture.error.message = "later wrapper"; fixture.cause.message = "later cause"; return []; };
  const fact = fixture.capture();
  expect(fact.error.message).toContain("original native refusal");
  expect(fact.refusal.cause.message).toBe("original native refusal");
});

test("launch facts coexist with Browser traps and survive later samples, end and late messages", async () => {
  const fixture = launchFailureFixture();
  const module = await WebAssembly.compile(browserTrapSource());
  const instance = await WebAssembly.instantiate(module);
  const id = crypto.randomUUID();
  const transport = beginMemorySnapshot("browser", id, "launch-trap-command", module);
  if (!transport) throw Error("Missing telemetry channel");
  try {
    const fact = fixture.capture();
    recordLaunchFailure(id, fact);
    publishBrowserCallTrap(instance, 7, transport, recordMemorySnapshot);
    const current = retainedMemorySnapshots().find(value => value.id === id);
    if (!current) throw Error("Missing retained snapshot");
    const later = { ...current, launchFailures: undefined, engineCounters: {}, allocatorFailure: { bytes: 123, category: "control" }, failedAllocation: { bytes: 123, category: "control" } };
    createMemoryPublisher(transport.buffer, { sample: () => later, finish: () => later }).capture(false, true);
    recordMemorySnapshot({ type: "bun-memory", snapshot: later });
    endMemorySnapshot(id);
    recordMemorySnapshot({ type: "bun-memory", snapshot: { ...later, failedAllocation: null, allocatorFailure: null } });
    const retained = retainedMemorySnapshots().find(value => value.id === id);
    expect(retained).toMatchObject({ terminal: true, failedAllocation: { bytes: 123 }, launchFailures: [fact],
      engineCounters: { browserCallTrapIndex: 7, browserCallTrapCapacityBytes: 65536 } });
    const observation = retainedMemoryProcesses().processes.find(value => value.id === id);
    expect(observation?.sample).not.toBeNull();
    expect(observation?.sample).not.toHaveProperty("launchFailures");
    expect(JSON.stringify(observation)).not.toContain("original native refusal");
    for (let attempt = 2; attempt <= 5; attempt++) recordLaunchFailure(id, { ...fixture.capture(), attempt });
    expect(retainedMemorySnapshots().find(value => value.id === id)?.launchFailures?.map(value => value.attempt)).toEqual([4, 5]);
    recordLaunchFailure(id, { ...fixture.capture(), attempt: 5, cleanupError: errorFact(Error("cleanup")) });
    const facts = retainedMemorySnapshots().find(value => value.id === id)?.launchFailures;
    expect(facts?.map(value => value.attempt)).toEqual([4, 5]);
    expect(facts?.[1]?.cleanupError?.message).toBe("cleanup");
  } finally { endMemorySnapshot(id); }
});

test("cached terminal telemetry stays newer than delayed messages while retaining launch facts", () => {
  const id = crypto.randomUUID();
  const transport = beginMemorySnapshot("browser", id, "delayed-launch-control");
  if (!transport) throw Error("Missing telemetry channel");
  const initial = retainedMemorySnapshots().find(value => value.id === id);
  if (!initial) throw Error("Missing initial snapshot");
  const frozen = (bytes: number): FrozenAllocatorFailure => ({ bytes, category: "libc.malloc", previousUsableBytes: 0,
    allocatorLiveBytes: bytes, allocatorPeakBytes: bytes, wasmCapacityBeforeBytes: 65536, wasmCapacityAfterBytes: 65536, reason: "unknown",
    growth: { kind: "not-attempted" } });
  const old = { ...initial, time: initial.time + 60_000, engineCounters: { browserCallTrapIndex: 7, browserCallTrapCapacityBytes: 65536 }, frozenAllocatorFailure: frozen(111) };
  const newer = { ...old, time: old.time + 60_000, engineCounters: { browserCallTrapIndex: 9, browserCallTrapCapacityBytes: 131072 }, frozenAllocatorFailure: frozen(222) };
  const latest = { ...newer, time: newer.time + 1, engineCounters: { browserCallTrapIndex: 11, browserCallTrapCapacityBytes: 262144 }, frozenAllocatorFailure: frozen(333) };
  try {
    const fact = launchFailureFixture().capture();
    recordLaunchFailure(id, fact);
    createMemoryPublisher(transport.buffer, { sample: () => newer, finish: () => newer }).capture(false, true);
    endMemorySnapshot(id);
    recordMemorySnapshot({ type: "bun-memory", snapshot: old });
    expect(retainedMemorySnapshots().find(value => value.id === id)).toMatchObject({ terminal: true, time: newer.time,
      engineCounters: newer.engineCounters, frozenAllocatorFailure: newer.frozenAllocatorFailure, launchFailures: [fact] });
    expect(retainedMemoryProcesses().processes.find(value => value.id === id)?.sample).toMatchObject({ time: newer.time, terminal: false });
    recordMemorySnapshot({ type: "bun-memory", snapshot: latest });
    expect(retainedMemorySnapshots().find(value => value.id === id)).toMatchObject({ terminal: true, time: latest.time,
      engineCounters: latest.engineCounters, frozenAllocatorFailure: latest.frozenAllocatorFailure, launchFailures: [fact] });
    expect(retainedMemoryProcesses().processes.find(value => value.id === id)?.sample).toMatchObject({ time: newer.time, terminal: false });
  } finally { endMemorySnapshot(id); }
});

test("a delayed command frame cannot replace another command's reused diagnostic record", () => {
  const id = crypto.randomUUID();
  beginMemorySnapshot("browser", id, "previous-launch-command");
  const old = retainedMemorySnapshots().find(value => value.id === id);
  if (!old) throw Error("Missing previous snapshot");
  beginMemorySnapshot("browser", id, "current-launch-command");
  const current = retainedMemorySnapshots().find(value => value.id === id);
  if (!current) throw Error("Missing current snapshot");
  try {
    const fact = launchFailureFixture().capture();
    recordLaunchFailure(id, fact);
    recordMemorySnapshot({ type: "bun-memory", snapshot: { ...old, time: current.time + 1,
      failedAllocation: { bytes: 111, category: "previous command" } } });
    expect(retainedMemorySnapshots().find(value => value.id === id)).toMatchObject({ commandId: current.commandId,
      commandSequence: current.commandSequence, commandStartedAt: current.commandStartedAt, time: current.time,
      failedAllocation: null, launchFailures: [fact] });
  } finally { endMemorySnapshot(id); }
});
