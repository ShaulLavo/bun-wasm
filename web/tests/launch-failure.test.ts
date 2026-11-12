import { expect, test } from "bun:test";
import { launchFailureFixture } from "../../scripts/fixtures/launch-failure.ts";
import { browserTrapSource } from "../../scripts/fixtures/browser-call-trap.ts";
import { copyLaunchFailure, errorFact, launchFailureFact, maxLaunchFailureBytes } from "../src/launch-failure.ts";
import { beginMemorySnapshot, endMemorySnapshot, publishBrowserCallTrap, recordLaunchFailure, recordMemorySnapshot, retainedMemorySnapshots } from "../src/memory-telemetry.ts";
import { createMemoryPublisher } from "../src/memory-channel.ts";

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
    for (let attempt = 2; attempt <= 5; attempt++) recordLaunchFailure(id, { ...fixture.capture(), attempt });
    expect(retainedMemorySnapshots().find(value => value.id === id)?.launchFailures?.map(value => value.attempt)).toEqual([4, 5]);
    recordLaunchFailure(id, { ...fixture.capture(), attempt: 5, cleanupError: errorFact(Error("cleanup")) });
    const facts = retainedMemorySnapshots().find(value => value.id === id)?.launchFailures;
    expect(facts?.map(value => value.attempt)).toEqual([4, 5]);
    expect(facts?.[1]?.cleanupError?.message).toBe("cleanup");
  } finally { endMemorySnapshot(id); }
});
