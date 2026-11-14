import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExitOwner, type Sink } from "./safari-exit-observer";
import { endpoint, fakeNative, fakeSubscription, targetRecords } from "./safari-exit-fixture";
import { jsonlSink } from "./safari-exit-sink";
import { withSafariCausalCapture, settlementFile, type SafariCausalCapture } from "./safari-causal-capture";
import { createSafariTransport } from "./safari-transport";
import { Scope } from "./scope";
import { scoped, type Transport } from "./scoped-transport";
import { clock, type SafariProtocolFact } from "./safari-protocol";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const target = { pid: 101, birth: "7" };
const noopSink: Sink = { async write() {}, async close() {} };
const identity = { run: "report-local", source: { commit: "972a04f46ffa7e02098ab47d31fdd2647e716afe", dirty: false }, cell: "tiny/safari/browser", attempt: 1 };

async function admitted(operation: Parameters<Scope["run"]>[0]): Promise<unknown> {
  const scope = Scope.open(5000);
  try { return await scope.run(operation); }
  finally { scope.close(); }
}

function fixture(options: { sink?: Sink; joinMs?: number; pollMs?: number } = {}) {
  const native = fakeNative();
  const fake = fakeSubscription();
  const opened: number[] = [];
  const owner = new ExitOwner({ native: native.native, open(pid) { opened.push(pid); return fake.subscription; }, sink: options.sink ?? noopSink,
    joinMs: options.joinMs ?? 30, pollMs: options.pollMs ?? 2 });
  cleanup.push(() => owner.finish());
  return { owner, native, fake, opened };
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "bun-wasm-exit-lifecycle-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  if (process.env.LIFECYCLE_DIRECTORY_LEDGER) await appendFile(process.env.LIFECYCLE_DIRECTORY_LEDGER, path + "\n");
  return path;
}

async function workload(f: ReturnType<typeof fixture>, capture: SafariCausalCapture, inner: Transport,
  mutate: (f: ReturnType<typeof fixture>) => void, saveError: (error: unknown) => void) {
  await admitted(admission => capture.arm(scoped(inner, admission), admission));
  expect(f.opened).toEqual([101]);
  mutate(f);
  try { await admitted(admission => inner.evaluate("workload", admission)); }
  catch (error) { saveError(error); f.fake.event(); await Bun.sleep(8); throw error; }
}

async function beginCleanup(transport: Transport | undefined) {
  await admitted(async admission => { await transport?.beginCleanup?.(admission); });
}

function abortWait(signal: AbortSignal, rejectOnAbort: boolean, onAbort: () => void = () => {}) {
  return new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => {
    onAbort();
    if (rejectOnAbort) reject(signal.reason);
    else resolve();
  }, { once: true }));
}

function neverSettles() { return new Promise<void>(() => {}); }

async function captureRun(mode: "null" | "404" | "hang-delete", mutate: (f: ReturnType<typeof fixture>) => void = () => {}) {
  const f = fixture({ joinMs: 2000 });
  const logs = await directory();
  const driver = endpoint(f.native, { fail: mode });
  cleanup.push(() => driver.stop());
  let caught: unknown;
  let settledBeforeOuter = false;
  let transport: Transport | undefined;
  const pending = f.owner.run(() => withSafariCausalCapture({ logs, identity, native: f.native.native, windowMs: 35, pollMs: 2, onAssociated: f.owner.attach }, async capture => {
    const inner = await createSafariTransport({ endpoint: driver.url, browser: "safari", timeoutMs: 1000, cleanupTimeoutMs: 100,
      ownershipSink: capture.ownership(undefined), protocolSink: fact => { capture.protocol(fact); f.owner.protocol(fact); } });
    transport = f.owner.transport(inner);
    return f.owner.attempt(() => workload(f, capture, inner, mutate, error => { caught = error; }), [
      { phase: "foreground-cleanup", run: () => beginCleanup(transport) },
      // Label the page-cleanup handoff. After failure, this fixture sends no page command.
      { phase: "page-cleanup", run: async () => {} },
      { phase: "session-delete", run: async () => { await transport?.close(); } },
    ]);
  }), [
    { phase: "driver-teardown", run: async () => {
      const capture = JSON.parse(await readFile(join(logs, settlementFile), "utf8"));
      settledBeforeOuter = capture.state === "settled";
      expect(f.fake.closes).toBe(0);
      f.fake.event(9); await Bun.sleep(5);
      await driver.stop();
    } },
    { phase: "app-teardown", run: async () => { f.fake.event(15); } },
  ]);
  const error = await pending.then(() => undefined, error => error);
  return { ...f, driver, logs, error, caught, settledBeforeOuter };
}

test("null async reply preserves its error, subscription survives identity loss and capture settlement through outer teardown", async () => {
  const f = await captureRun("null", f => { f.native.births.delete(101); });
  expect(f.error).toBe(f.caught);
  expect(String(f.error)).toContain("Invalid Safari WebDriver object");
  expect(f.settledBeforeOuter).toBe(true);
  expect(f.opened).toEqual([101]);
  expect(f.fake.closes).toBe(1);
  expect(f.owner.proof()).toMatchObject({ state: "settled", descriptor: "closed", eventCount: 3, writersJoined: true, writersClosed: true });
  const facts = targetRecords(f.owner, "protocol").map(entry => entry.value);
  expect(f.owner.proof().firstInvalid).toMatchObject({ status: 200, value: "null", result: { kind: "contract-failure" } });
  const firstInvalid = f.owner.proof().firstInvalid;
  if (!firstInvalid) throw new Error("Missing invalid reply");
  const records = f.owner.records.length;
  f.owner.protocol(firstInvalid);
  expect(f.owner.records.length).toBe(records);
  expect(f.owner.proof().lateFacts).toBe(1);
  expect(facts).toContainEqual(expect.objectContaining({ command: "session-delete" }));
  const asyncRequests = f.driver.requests.filter(item => item.path.endsWith("/execute/async"));
  expect(asyncRequests).toHaveLength(3); // Two association pulses and the failed workload, no follow-up.
  const settlement = JSON.parse(await readFile(join(f.logs, settlementFile), "utf8"));
  expect(settlement.identityLost).toMatchObject({ reason: "exited" });
  expect(targetRecords(f.owner, "exit-poll").filter(entry => entry.phase === "driver-teardown")).not.toBeEmpty();
});

test("404 status and exact error survive failed session cleanup and PID reuse without rebinding", async () => {
  const f = await captureRun("404", f => { f.native.births.set(101, "replacement"); });
  expect(f.error).toBe(f.caught);
  expect(String(f.error)).toContain("(404)");
  expect(f.owner.proof()).toMatchObject({ state: "unproved", descriptor: "closed", eventCount: 3,
    firstInvalid: { status: 404, result: { kind: "http-error", error: "invalid session id" } } });
  expect(f.opened).toEqual([101]);
  const events = targetRecords(f.owner, "exit-poll").filter(entry => typeof entry.value === "object" && entry.value !== null && "kind" in entry.value && entry.value.kind === "event");
  expect(events.every(entry => entry.target?.birth === "7")).toBe(true);
});

test("actual endpoint session hang is bounded, retains workload error, and still permits outer teardown", async () => {
  const f = await captureRun("hang-delete");
  expect(f.error).toBe(f.caught);
  expect(f.owner.proof()).toMatchObject({ state: "unproved", descriptor: "closed", writersClosed: true });
  expect(f.fake.closes).toBe(1);
  expect(f.settledBeforeOuter).toBe(true);
});

test("read exceptions end maintained identity sampling but the independent exit reader continues", async () => {
  const f = await captureRun("null", f => { f.native.native.read = () => { throw new Error("identity reader unavailable"); }; });
  expect(f.error).toBe(f.caught);
  expect(f.owner.proof().eventCount).toBe(3);
  const settlement = JSON.parse(await readFile(join(f.logs, settlementFile), "utf8"));
  expect(settlement.degraded).toContainEqual(expect.objectContaining({ file: "native-reader" }));
  expect(f.fake.closes).toBe(1);
});

test("no attachment occurs without a unique page association", async () => {
  const f = fixture();
  const logs = await directory();
  const driver = endpoint(f.native);
  cleanup.push(() => driver.stop());
  f.native.native.candidates = async () => [];
  const error = await f.owner.run(() => withSafariCausalCapture({ logs, identity, native: f.native.native, windowMs: 20, onAssociated: f.owner.attach }, async capture => {
    const transport = await createSafariTransport({ endpoint: driver.url, browser: "safari", timeoutMs: 100,
      ownershipSink: capture.ownership(undefined) });
    try { await admitted(admission => capture.arm(scoped(transport, admission), admission)); }
    finally { await transport.close(); }
  })).catch(error => error);
  expect(String(error)).toContain("0 of 0 candidates matched");
  expect(f.opened).toBeEmpty();
  expect(f.owner.proof()).toMatchObject({ descriptor: "not-opened", eventCount: 0 });
});

test("birth mismatch before or after registration blocks workload and closes only an acquired descriptor", async () => {
  for (const moment of ["before", "after"]) {
    const f = fixture();
    if (moment === "before") f.native.births.set(101, "8");
    const read = f.native.native.read;
    let reads = 0;
    f.native.native.read = pid => { reads++; if (moment === "after" && reads === 2) f.native.births.set(101, "8"); return read(pid); };
    const error = await f.owner.run(async () => { f.owner.attach(target); throw new Error("workload ran"); }).catch(error => error);
    expect(String(error)).toContain(`birth mismatch ${moment}`);
    expect(f.opened).toHaveLength(moment === "before" ? 0 : 1);
    expect(f.fake.closes).toBe(moment === "before" ? 0 : 1);
    expect(() => f.owner.attach(target)).toThrow("already settled");
  }
});

test("registration failure keeps original error and its factory disposes its descriptor once", async () => {
  const failure = new Error("EV_RECEIPT EACCES raw retained");
  const f = fixture();
  let closed = 0;
  const owner = new ExitOwner({ native: f.native.native, sink: noopSink, open() { closed++; throw failure; } });
  const error = await owner.run(async () => owner.attach(target)).catch(error => error);
  expect(error).toBe(failure);
  expect(closed).toBe(1);
  expect(owner.proof().descriptor).toBe("unproved");
});

test("empty and late event observations stay explicit with exact raw bytes, flags, birth and receipt clocks", async () => {
  const f = fixture();
  f.owner.attach(target);
  f.owner.drain();
  const before = targetRecords(f.owner, "exit-poll");
  expect(before[0]?.value).toMatchObject({ kind: "empty", count: 0 });
  const event = f.fake.event(9, 0x80000000);
  f.owner.boundary("foreground-cleanup");
  await f.owner.run(async () => {}, [{ phase: "app-teardown", run: async () => { f.fake.event(9); } }]);
  const observed = targetRecords(f.owner, "exit-poll").find(entry => typeof entry.value === "object" && entry.value !== null && "kind" in entry.value && entry.value.kind === "event");
  expect(observed?.value).toBe(event);
  expect(event.raw.hex).toHaveLength(96);
  expect(event.decoded).toMatchObject({ statusAvailable: false, detailAvailable: false, waitStatus: null, signal: null, exitCode: null, kernelMemoryExit: null });
  expect(observed?.phase).toBe("workload"); // Pre-dispatch drain precedes cleanup.
  expect(observed?.target).toEqual(target);
  expect(f.owner.proof().eventCount).toBe(2);
  expect(f.owner.records.some(entry => entry.phase === "app-teardown" && entry.kind === "exit-poll")).toBe(true);
});

test("absent exit settles without waiting for it, closes once, and stops polling", async () => {
  const f = fixture();
  await f.owner.run(async () => { f.owner.attach(target); await Bun.sleep(7); });
  const polls = f.fake.polls;
  await f.owner.finish(); await Bun.sleep(7);
  expect(f.fake.polls).toBe(polls);
  expect(f.fake.closes).toBe(1);
  expect(f.owner.proof()).toMatchObject({ state: "settled", eventCount: 0 });
  expect(() => f.owner.attach(target)).toThrow("already settled");
});

test("the real JSONL writer retains complete registration/event bytes and clocks before closing", async () => {
  const logs = await directory();
  const path = join(logs, "observer.jsonl");
  const f = fixture({ sink: await jsonlSink(path) });
  const event = f.fake.event();
  await f.owner.run(async () => f.owner.attach(target));
  const lines: unknown[] = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(lines).toContainEqual(expect.objectContaining({ kind: "registration", value: f.fake.subscription.registration }));
  expect(lines).toContainEqual(expect.objectContaining({ kind: "exit-poll", target, value: event }));
  expect(lines.at(-1)).toMatchObject({ kind: "observer-settled", value: { descriptor: "closed" } });
  expect(f.owner.proof()).toMatchObject({ state: "settled", writersClosed: true });
});

test("poll, writer and descriptor-close failures preserve exact guest result or thrown identity", async () => {
  const original = { status: "fail", error: "original guest status" };
  const thrown = new Error("original workload error");
  for (const mode of ["result", "throw"]) {
    const f = fixture({ sink: { async write() { throw new Error("sink failed"); }, async close() { throw new Error("writer close failed"); } } });
    f.fake.failPoll(new Error("poll failed")); f.fake.failClose(new Error("fd close failed"));
    const result = await f.owner.run(async () => { f.owner.attach(target); if (mode === "throw") throw thrown; return original; }).catch(error => error);
    expect(result).toBe(mode === "throw" ? thrown : original);
    expect(f.fake.closes).toBe(1);
    expect(f.owner.proof()).toMatchObject({ state: "unproved", descriptor: "unproved", writersClosed: false });
    expect(f.owner.degraded.map(item => item.source)).toContainValues(["poll", "writer", "close", "writer-close"]);
  }
});

test("cleanup throw, cooperative hang, noncooperative hang and cancellation retain original error and continue teardown", async () => {
  for (const mode of ["throw", "hang", "unjoined", "cancel"]) {
    const f = fixture({ joinMs: 8 });
    const cancellation = new AbortController();
    const failure = new Error("original cancelled operation");
    let outer = false;
    const result = await f.owner.run(async () => { f.owner.attach(target); cancellation.abort(failure); throw cancellation.signal.reason; }, [
      { phase: "foreground-cleanup", run: async signal => {
        if (mode === "throw") throw new Error("cleanup failed");
        if (mode === "unjoined") return neverSettles();
        if (mode === "hang") await abortWait(signal, true);
      } },
      { phase: "driver-teardown", run: async () => { outer = true; f.fake.event(9); } },
    ]).catch(error => error);
    expect(result).toBe(failure);
    expect(outer).toBe(true);
    expect(f.fake.closes).toBe(1);
    expect(f.owner.proof().state).toBe(mode === "cancel" ? "settled" : "unproved");
  }
});

test("writer cancellation joins before close; an unjoined writer cannot claim final cleanup proof", async () => {
  for (const mode of ["cooperative", "unjoined", "close-hang", "close-unjoined"]) {
    const order: string[] = [];
    const f = fixture({ joinMs: 5, sink: {
      async write(entry, signal) {
        order.push("write");
        if (mode === "close-hang" || mode === "close-unjoined") return;
        if (mode === "unjoined") return neverSettles();
        await abortWait(signal, false, order.push.bind(order, "joined"));
      },
      async close(signal) { order.push("close"); if (mode === "close-unjoined") return neverSettles(); if (mode === "close-hang") await abortWait(signal, true); },
    } });
    await f.owner.run(async () => f.owner.attach(target));
    expect(f.fake.closes).toBe(1);
    expect(f.owner.proof().state).toBe("unproved");
    expect(order.at(-1)).toBe(mode === "unjoined" ? "write" : "close");
    expect(f.owner.proof().writersJoined).toBe(mode !== "unjoined" && mode !== "close-unjoined");
  }
});

test("owned child and output readers join before descriptor close, writers close, then final proof", async () => {
  const order: string[] = [];
  const f = fixture({ sink: { async write() { order.push("write"); }, async close() { order.push("writers-closed"); } } });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const stopChild = async () => { if (child && child.exitCode === null) child.kill(); if (child) await child.exited; };
  cleanup.push(stopChild); // Installed before spawn.
  child = Bun.spawn([process.execPath, "-e", "process.stdout.write('owned'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "pipe" });
  if (process.env.LIFECYCLE_PID_LEDGER) await appendFile(process.env.LIFECYCLE_PID_LEDGER, String(child.pid) + "\n");
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  await f.owner.run(async () => f.owner.attach(target), [{ phase: "driver-teardown", run: async () => {
    await stopChild(); await Promise.all([stdout, stderr]); order.push("child-and-readers-joined"); f.fake.event(9);
  } }]);
  order.push("proof");
  expect(f.owner.proof().state).toBe("settled");
  expect(order.indexOf("child-and-readers-joined")).toBeLessThan(order.indexOf("writers-closed"));
  expect(order.at(-1)).toBe("proof");
  expect(await child.exited).not.toBe(0);
});

test("late protocol callbacks during writer close cannot enqueue writes or change final attribution", async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture({ joinMs: 1000, sink: { async write() {}, async close() { started.resolve(); await release.promise; } } });
  cleanup.push(async () => { release.resolve(); });
  const pending = f.owner.run(async () => f.owner.attach(target));
  await started.promise;
  const count = f.owner.records.length;
  const fact = { request: 1, lane: "command", method: "POST", command: "execute-async", dispatched: clock(), settled: clock(), status: 200,
    media: "json", envelope: "object", value: "null", result: { kind: "contract-failure" } } satisfies SafariProtocolFact;
  f.owner.protocol(fact);
  expect(f.owner.records.length).toBe(count);
  expect(f.owner.proof()).toMatchObject({ lateFacts: 1, firstInvalid: null });
  release.resolve();
  await pending;
  expect(f.owner.proof()).toMatchObject({ state: "settled", writersClosed: true });
});
