import { expect, test } from "bun:test";
import { createFilesystemIdentity } from "waffle/fs";
import { bytes, SharedMemoryAdmissionError, type SharedMemorySnapshot } from "waffle";
import { createProcessConnectionCapture, connectProcessFilesystem, type ConnectionRuntime } from "./process-connection-capture";
import { createProcessPageSuite } from "./process-page-suite";
import { readProcessDiagnosticEnvelope } from "./process-diagnostic-adapter";

const snapshot = (): SharedMemorySnapshot => ({ platform: { kind: "unbounded", source: "default" }, budgetBytes: null,
  reservedBytes: 10, availableBytes: null, awaitingReleaseBytes: 0, debtBytes: 0, effectiveBudgetBytes: null,
  contradictions: [], sharedGuests: [], holders: [] });
const identity = createFilesystemIdentity();
const controller = { kind: "parent", pid: 7, parentPid: 7 } as const;
const refusal = () => new SharedMemoryAdmissionError({ kind: "platform", label: "request-arena", cause: new RangeError("injected refusal") });

function runtime(throwing: unknown, events: string[], read = snapshot): ConnectionRuntime {
  return { filesystem: { connect() { events.push("connect"); throw throwing; } }, sharedMemory: { snapshot() { events.push("snapshot"); return read(); } } };
}
function thrown(operation: () => unknown): unknown {
  try { operation(); }
  catch (error) { return error; }
  throw new Error("expected controlled throw");
}

test("connection refusal is copied before cleanup and survives through the existing post-finally envelope", async () => {
  const events: string[] = [], capture = createProcessConnectionCapture();
  const scope = capture.scope("original case"), original = refusal();
  const suite = createProcessPageSuite(async () => {
    try { expect(thrown(() => connectProcessFilesystem(runtime(original, events), identity, scope, controller))).toBe(original); }
    finally { await scope.dispose(async () => { events.push("cleanup"); }); }
    return { result: { ok: false, error: String(original) }, progress: {}, connectionFailure: capture.read() };
  }, [], failure => { events.push("envelope"); return failure; });
  const envelope = readProcessDiagnosticEnvelope(await suite.run({ databaseName: "bun-process-control" }, async () => {}));
  expect(events).toEqual(["snapshot", "connect", "snapshot", "cleanup", "envelope"]);
  expect(envelope.diagnostic).toMatchObject({ status: "captured", value: { caseLabel: "original case", scopeOrdinal: 1,
    controller, previousScopeDisposal: null, refusal: { code: "ENOMEM", refusal: { kind: "platform", label: "request-arena", cause: { message: "injected refusal" } } },
    beforeConnect: { status: "captured" }, onFailure: { status: "captured" } } });
});

for (const original of [undefined, null, false, 0, "", Object.create(null), { get toString() { throw new Error("awkward"); } }]) {
  test(`snapshot failure preserves exact thrown value ${typeof original}`, () => {
    const capture = createProcessConnectionCapture(), events: string[] = [];
    const value = thrown(() => connectProcessFilesystem(runtime(original, events, () => { throw new Error("snapshot failed"); }), identity, capture.scope("case"), controller));
    expect(value).toBe(original);
    expect(events).toEqual(["snapshot", "connect", "snapshot"]);
    expect(capture.read()).toMatchObject({ refusal: null, beforeConnect: { status: "unavailable" }, onFailure: { status: "unavailable" } });
  });
}

test("disabled capture never snapshots and still rethrows the same value", () => {
  const events: string[] = [], original = refusal();
  expect(thrown(() => connectProcessFilesystem(runtime(original, events), identity, undefined, controller))).toBe(original);
  expect(events).toEqual(["connect"]);
});

for (const status of ["fulfilled", "rejected"] as const) {
  test(`prior scope disposal records ${status} only after its original await settles`, async () => {
    const capture = createProcessConnectionCapture(), previous = capture.scope("previous");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = Object.create(null);
    const pending = previous.dispose(async () => { await gate; if (status === "rejected") throw original; });
    const rejection = pending.catch(error => error);
    const during = capture.scope("during");
    thrown(() => connectProcessFilesystem(runtime(refusal(), []), identity, during, controller));
    expect(capture.read()?.previousScopeDisposal).toEqual({ scopeOrdinal: 1, status: "pending" });
    release();
    expect(await rejection).toBe(status === "rejected" ? original : undefined);
    const settled = createProcessConnectionCapture(), first = settled.scope("first");
    await first.dispose(async () => { if (status === "rejected") throw original; }).catch(error => expect(error).toBe(original));
    const next = settled.scope("next");
    thrown(() => connectProcessFilesystem(runtime(refusal(), []), identity, next, controller));
    expect(settled.read()?.previousScopeDisposal).toEqual({ scopeOrdinal: 1, status });
  });
}

test("only the first failure is retained, with bounded copied values and no error or buffer objects", () => {
  const capture = createProcessConnectionCapture(), source = { ...snapshot(), reservedBytes: 10, holders: snapshot().holders }, original = refusal();
  if (original.refusal.kind !== "platform") throw new Error("platform fixture");
  const long = "x".repeat(20_000);
  source.holders = Array.from({ length: 100 }, () => ({ label: "request-arena", scope: "runtime", state: "live", declaredBytes: bytes(10), grownBytes: null, shape: { kind: "fixed-buffer", length: bytes(10) } }));
  original.refusal.cause.message = long;
  const scope = capture.scope(long), events: string[] = [];
  thrown(() => connectProcessFilesystem(runtime(original, events, () => source), identity, scope, controller));
  const saved = JSON.stringify(capture.read());
  source.reservedBytes = 900;
  original.refusal.cause.message = "mutated";
  thrown(() => connectProcessFilesystem(runtime(refusal(), events), identity, scope, controller));
  expect(JSON.stringify(capture.read())).toBe(saved);
  expect(saved.length).toBeLessThan(12_000);
  expect(capture.read()?.caseLabel.length).toBeLessThanOrEqual(128);
  expect(events.filter(event => event === "snapshot")).toHaveLength(2);
  expect(capture.read()?.beforeConnect).toMatchObject({ status: "captured", value: { holderCount: 100, holdersOmitted: 92, holderCountsByLabelAndState: { "request-arena": { live: 100 } } } });
});

test("broken snapshot serialization and typed refusal getters cannot replace the connection exception", () => {
  const capture = createProcessConnectionCapture(), original = refusal();
  const source = snapshot();
  Object.defineProperty(source, "budgetBytes", { get() { throw new Error("snapshot serialization"); } });
  Object.defineProperty(original, "refusal", { get() { throw new Error("refusal access"); } });
  expect(thrown(() => connectProcessFilesystem(runtime(original, [], () => source), identity, capture.scope("case"), controller))).toBe(original);
  expect(capture.read()).toMatchObject({ refusal: null, beforeConnect: { status: "unavailable" }, onFailure: { status: "unavailable" } });
});

test("the connection record stays secondary when the existing diagnostic callback throws", async () => {
  const capture = createProcessConnectionCapture(), original = refusal();
  const run = async () => {
    thrown(() => connectProcessFilesystem(runtime(original, []), identity, capture.scope("controlled refusal"), controller));
    return { result: { ok: false, error: String(original), stack: original.stack }, progress: {}, connectionFailure: capture.read() };
  };
  const plain = await createProcessPageSuite(run, []).run({ databaseName: "bun-process-control" }, async () => {});
  const returned = await createProcessPageSuite(run, [], () => { throw new Error("diagnostic callback failed"); })
    .run({ databaseName: "bun-process-control" }, async () => {});
  const envelope = readProcessDiagnosticEnvelope(returned);
  expect(JSON.stringify(envelope.processResult)).toBe(JSON.stringify(plain));
  expect(envelope.diagnostic).toEqual({ status: "error", error: "Error: diagnostic callback failed" });
});

test("before-connect and failure snapshots are detached at their distinct live checkpoints", () => {
  const capture = createProcessConnectionCapture(), source = { ...snapshot(), reservedBytes: 10 }, original = refusal();
  const live: ConnectionRuntime = { sharedMemory: { snapshot: () => source }, filesystem: { connect() { source.reservedBytes = 20; throw original; } } };
  const root = { kind: "root", pid: 1, parentPid: null } as const;
  expect(thrown(() => connectProcessFilesystem(live, identity, capture.scope("root"), root))).toBe(original);
  source.reservedBytes = 30;
  expect(capture.read()).toMatchObject({ controller: root, beforeConnect: { value: { reservedBytes: 10 } }, onFailure: { value: { reservedBytes: 20 } } });
});

for (const original of [
  new SharedMemoryAdmissionError({ kind: "configuration", configuration: "memory64-module" }),
  new SharedMemoryAdmissionError({ kind: "budget", requested: bytes(9), available: bytes(2), budget: bytes(10), awaitingRelease: bytes(1) }),
  new SharedMemoryAdmissionError({ kind: "uncounted-platform", label: "control", requestedBytes: bytes(8), cause: new RangeError("controlled") }),
]) {
  test(`public ${original.refusal.kind} refusal fields survive plain-data copying`, () => {
    const capture = createProcessConnectionCapture();
    expect(thrown(() => connectProcessFilesystem(runtime(original, []), identity, capture.scope("case"), controller))).toBe(original);
    const expected = original.refusal.kind === "uncounted-platform" || original.refusal.kind === "platform"
      ? { ...original.refusal, cause: { name: "RangeError", message: "controlled" } } : original.refusal;
    expect(capture.read()?.refusal).toEqual({ name: original.name, code: original.code, errno: original.errno, refusal: expected });
  });
}
