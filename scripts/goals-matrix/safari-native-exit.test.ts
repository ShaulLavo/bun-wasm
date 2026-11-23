import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventListeners } from "node:events";
import { withNativeDriver, type NativeHost } from "./native";
import type { SafariInstance } from "./native-safari";
import { ownSafariDriver } from "../../web/tests/engine-interruption-safari";
import { ExitOwner, type Sink } from "./safari-exit-observer";
import { openExit, type ExitSyscalls } from "./safari-exit-syscalls";
import { endpoint, fakeNative, targetRecords } from "./safari-exit-fixture";
import { createSafariTransport } from "./safari-transport";
import { Scope } from "./scope";
import { jsonlSink } from "./safari-exit-sink";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// The wrapper never calls the instance here: the fixture's stopApp stops its own child.
const inertInstance: SafariInstance = { report: async () => ({ kind: "lost" }), own() {}, terminate: async () => false, detach() {}, release() {}, exited: Promise.resolve(0) };

async function fixture(joinMs = 1000, sink?: Sink) {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const controller = new AbortController();
  const events: string[] = [];
  const native = fakeNative();
  const pending: number[] = [];
  let closes = 0;
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-native-exit-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  if (process.env.LIFECYCLE_DIRECTORY_LEDGER) await appendFile(process.env.LIFECYCLE_DIRECTORY_LEDGER, root + "\n");
  const system: ExitSyscalls = {
    kqueue: () => 11, errno: () => 0,
    kevent64(_fd, change, event) {
      const data = change ? 0 : pending.shift();
      if (data === undefined) return 0;
      const view = new DataView(event.buffer);
      view.setBigUint64(0, 101n, true); view.setInt16(8, -5, true);
      view.setUint16(10, change ? 0x4041 : 0x8071, true);
      view.setUint32(12, 0x86000000, true); view.setBigInt64(16, BigInt(data), true);
      return 1;
    },
    close() { closes++; events.push("descriptor-close"); return 0; },
  };
  const owner = new ExitOwner({ native: native.native, open: pid => openExit(system, pid), joinMs,
    sink: sink ?? { async write() {}, async close() { events.push("writers-close"); } } });
  cleanup.push(() => owner.finish());
  cleanup.push(async () => { for (const child of children) await stop(child); });
  async function spawn() {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    children.push(child);
    if (process.env.LIFECYCLE_PID_LEDGER) await appendFile(process.env.LIFECYCLE_PID_LEDGER, String(child.pid) + "\n");
    return child;
  }
  // The driver's spawn boundary is synchronous. Teardown was installed before either spawn.
  const driver = await spawn();
  const app = await spawn();
  const io: NativeHost = {
    platform: "darwin", uid: () => 501, signals: operation => operation(controller.signal),
    queue: async () => { events.push("queue"); }, available: async () => {}, console: async () => "",
    prepare: async state => { events.push("prepare"); state.launch = { kind: "owned", requestedUs: 1n, instance: inertInstance, application: { pid: app.pid, bornUs: 2n } }; },
    port: async () => 12345, spawn: () => driver, own: ownSafariDriver, ready: async () => true,
    stopDriver: async () => { events.push("driver-stop"); pending.push(9); await stop(driver); },
    stopApp: async state => { events.push("app-stop"); pending.push(15); if (state.launch.kind !== "none") await stop(app); },
  };
  const config = { desktopSafari: true, cleanupFile: join(root, "receipt.json"), exitOwner: owner };
  return { root, io, owner, config, events, native, pending, controller, driver, app, get closes() { return closes; } };
}

async function stop(child: Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "signalCode" | "kill" | "exited">) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await child.exited;
}

test("actual native wrapper retains the operation error and attempts the app after driver failure, then drains and closes", async () => {
  const f = await fixture();
  const original = new Error("invalid protocol reply");
  const stopDriver = f.io.stopDriver;
  f.io.stopDriver = async (...args) => { await stopDriver(...args); throw new Error("driver cleanup failure"); };
  const result = await f.owner.run(() => withNativeDriver(async () => {
    f.owner.attach({ pid: 101, birth: "7" });
    f.native.births.set(101, "replacement");
    f.events.push("inner-capture-settled");
    throw original;
  }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.events).toEqual(["queue", "prepare", "inner-capture-settled", "driver-stop", "app-stop", "descriptor-close", "writers-close"]);
  expect(f.closes).toBe(1);
  expect(f.owner.proof()).toMatchObject({ state: "unproved", eventCount: 2, descriptor: "closed", childrenJoined: true, cleanupCompleted: false });
  expect(f.owner.cleanup[0]?.result).toMatchObject({ outcome: { kind: "error", error: { message: "driver cleanup failure" } } });
  expect(f.owner.records.filter(entry => entry.kind === "exit-poll").every(entry => entry.target?.birth === "7")).toBe(true);
  expect(JSON.parse(await readFile(f.config.cleanupFile, "utf8"))).toMatchObject({ driverExited: false, safariExited: true });
});

async function evaluateReply({ transport, scope, failed }: {
  transport: Parameters<ExitOwner["transport"]>[0];
  scope: Scope;
  failed: (error: unknown) => void;
}) {
  try { return await transport.evaluate("workload", scope); }
  catch (error) { failed(error); throw error; }
  finally { scope.close(); }
}

async function invalidReply(f: Awaited<ReturnType<typeof fixture>>, cancel: boolean) {
  const server = endpoint(f.native, { fail: "null" });
  cleanup.push(() => server.stop());
  const port = server.port;
  if (port === undefined) throw new Error("Fixture endpoint has no port");
  f.io.port = async () => port;
  let original: unknown;
  const result = await withNativeDriver(async address => {
    f.owner.attach({ pid: 101, birth: "7" });
    const inner = await createSafariTransport({ endpoint: address, browser: "safari", timeoutMs: 5000, protocolSink: f.owner.protocol });
    const transport = f.owner.transport(inner);
    if (cancel) f.controller.abort(new Error("external cancellation"));
    const scope = Scope.open(5000);
    return f.owner.attempt(() => evaluateReply({ transport, scope, failed: error => { original = error; } }),
      [{ phase: "session-delete", run: () => transport.close() }]);
  }, f.config, f.io).catch(error => error);
  expect(result).toBe(original);
  expect(String(result)).toContain("Invalid Safari WebDriver object");
  return { result, server };
}

test.each([false, true])("real null reply snapshots retained children and cancellation %s before session deletion and independent teardown", async cancel => {
  const f = await fixture();
  const listeners = getEventListeners(f.controller.signal, "abort").length;
  await f.owner.run(() => invalidReply(f, cancel));
  expect(f.owner.proof()).toMatchObject({ state: "settled", firstInvalid: { command: "execute-async", status: 200, value: "null" } });
  const snapshots = targetRecords(f.owner, "native-state");
  const first = snapshots.find(entry => typeof entry.value === "object" && entry.value !== null && "moment" in entry.value && entry.value.moment === "first-invalid");
  expect(first).toMatchObject({ phase: "workload", target: { pid: 101, birth: "7" }, value: { state: {
    observerPid: process.pid, observedAt: { utc: expect.any(String), monotonicMs: expect.any(Number) },
    driver: { child: { source: "retained-child-handle", pid: f.driver.pid, exitCode: null, signalCode: null }, spawnedAfter: expect.any(Number), root: null },
    safari: { kind: "owned", requestedUs: "1", application: { pid: f.app.pid, bornUs: "2" } },
    cancellation: { source: "native-wrapper-signal", aborted: cancel, reason: cancel ? { kind: "error", name: "Error" } : null },
  } } });
  const deletion = f.owner.records.find(entry => entry.kind === "dispatch-boundary" && entry.phase === "session-delete");
  if (!first || !deletion) throw new Error("Missing first-invalid snapshot or deletion boundary");
  expect(first.sequence).toBeLessThan(deletion.sequence);
  expect(snapshots).toContainEqual(expect.objectContaining({ phase: "driver-teardown", value: expect.objectContaining({ moment: "after-teardown", state: expect.objectContaining({ driver: expect.objectContaining({ child: expect.objectContaining({ signalCode: "SIGKILL" }) }), safari: { kind: "owned", requestedUs: "1", application: { pid: f.app.pid, bornUs: "2" } } }) }) }));
  expect(snapshots).toContainEqual(expect.objectContaining({ phase: "app-teardown", value: expect.objectContaining({ moment: "after-teardown", state: expect.objectContaining({ safari: expect.objectContaining({ kind: "owned" }) }) }) }));
  expect(f.app.signalCode).toBe("SIGKILL");
  expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(listeners);
  const count = f.owner.records.length;
  f.controller.abort();
  expect(f.owner.records).toHaveLength(count);
});

test("exit observed before first-invalid and cancellation during failing teardown stay separate from cleanup success", async () => {
  const f = await fixture();
  // The driver is the retained child; desktop Safari is a LaunchServices process.
  await stop(f.driver);
  const original = { failure: "operation" };
  f.io.stopDriver = async () => { f.controller.abort(new Error("cancel during teardown")); await stop(f.driver); throw new Error("driver failure"); };
  const result = await f.owner.run(() => withNativeDriver(async () => {
    f.owner.attach({ pid: 101, birth: "7" });
    const at = { utc: new Date().toISOString(), monotonicMs: performance.now() };
    f.owner.protocol({ request: 1, lane: "command", method: "POST", command: "execute-async", dispatched: at, settled: at, status: 200, media: "json", envelope: "object", value: "null", result: { kind: "contract-failure" } });
    throw original;
  }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(targetRecords(f.owner, "native-state")).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ moment: "first-invalid", state: expect.objectContaining({ driver: expect.objectContaining({ child: expect.objectContaining({ signalCode: "SIGKILL" }) }) }) }) }));
  expect(targetRecords(f.owner, "native-state")).toContainEqual(expect.objectContaining({ phase: "driver-teardown", value: expect.objectContaining({ moment: "cancellation", state: expect.objectContaining({ cancellation: expect.objectContaining({ aborted: true }) }) }) }));
  expect(f.events).toContain("app-stop");
  expect(f.owner.proof()).toMatchObject({ state: "unproved", descriptor: "closed", writersClosed: true, cleanupCompleted: false });
});

test("delayed real JSONL writes retain earlier handle values and close only after wrapper teardown", async () => {
  const gate = Promise.withResolvers<void>();
  cleanup.push(async () => { gate.resolve(); });
  const f = await fixture(5000, { async write(entry, signal) { await gate.promise; await sink.write(entry, signal); }, async close(signal) { await sink.close(signal); } });
  const path = join(f.root, "native-state.jsonl");
  const sink = await jsonlSink(path);
  const running = f.owner.run(async () => {
    const result = await invalidReply(f, false);
    gate.resolve();
    return result;
  });
  try { await running; }
  finally { gate.resolve(); await running; }
  const entries: unknown[] = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(entries).toContainEqual(expect.objectContaining({ kind: "native-state", value: expect.objectContaining({ moment: "first-invalid", state: expect.objectContaining({ driver: expect.objectContaining({ child: expect.objectContaining({ signalCode: null }) }) }) }) }));
  expect(entries).toContainEqual(expect.objectContaining({ kind: "native-state", phase: "app-teardown", value: expect.objectContaining({ moment: "after-teardown", state: expect.objectContaining({ driver: expect.objectContaining({ child: expect.objectContaining({ signalCode: "SIGKILL" }) }) }) }) }));
  expect(f.owner.proof()).toMatchObject({ state: "settled", writersJoined: true, writersClosed: true });
  const count = f.owner.records.length;
  f.owner.snapshotNative("cancellation");
  expect(f.owner.records).toHaveLength(count);
  expect(f.owner.proof().lateFacts).toBe(1);
});

test.each(["reject", "unjoined"])("native wrapper preserves the real protocol error when its %s writer fails", async mode => {
  const gate = Promise.withResolvers<void>();
  let closed = false;
  const f = await fixture(100, { async write() { if (mode === "reject") throw new Error("writer failed"); await gate.promise; }, async close() { closed = true; } });
  let original: unknown;
  try {
    const result = await f.owner.run(async () => { original = (await invalidReply(f, false)).result; throw original; }).catch(error => error);
    expect(result).toBe(original);
    expect(f.events).toContainValues(["driver-stop", "app-stop", "descriptor-close"]);
    expect(f.owner.proof()).toMatchObject({ state: "unproved", descriptor: "closed", childrenJoined: true, writersJoined: mode === "reject", writersClosed: mode === "reject" });
    expect(closed).toBe(mode === "reject");
  } finally { gate.resolve(); }
});

// Desktop Safari has no child handle; the driver handle is the one a snapshot reads.
function unreadableDriver(driver: ReturnType<typeof Bun.spawn>, message: string): ReturnType<typeof Bun.spawn> {
  return new Proxy(driver, { get(target, key) {
    if (key === "exitCode") throw new Error(message);
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("disabled capture reads no added handle snapshots and removes no signal listener", async () => {
  const f = await fixture();
  f.io.spawn = () => unreadableDriver(f.driver, "unexpected snapshot");
  f.io.stopApp = async () => { await stop(f.app); };
  const expected = { unchanged: true };
  expect(await withNativeDriver(async () => expected, { desktopSafari: true }, f.io)).toBe(expected);
  expect(getEventListeners(f.controller.signal, "abort")).toBeEmpty();
  expect(targetRecords(f.owner, "native-state")).toBeEmpty();
});

test("snapshot read failure degrades evidence without replacing the operation or skipping either cleanup", async () => {
  const f = await fixture();
  f.io.spawn = () => unreadableDriver(f.driver, "handle read failed");
  f.io.stopApp = async () => { f.events.push("app-stop"); await stop(f.app); };
  const original = new Error("original");
  const result = await f.owner.run(() => withNativeDriver(async () => { throw original; }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.owner.degraded).toContainEqual(expect.objectContaining({ source: "native-state", error: expect.objectContaining({ message: "handle read failed" }) }));
  expect(f.events).toContainValues(["driver-stop", "app-stop", "writers-close"]);
  expect(f.owner.proof()).toMatchObject({ observation: "degraded", childrenJoined: true, writersClosed: true });
});

test("an already cancelled wrapper records absent handles before setup and detaches its reader before final writer close", async () => {
  const f = await fixture();
  const original = new Error("cancelled before setup");
  f.controller.abort(original);
  f.io.available = async signal => { signal.throwIfAborted(); };
  const result = await withNativeDriver(async () => { throw new Error("workload admitted"); }, f.config, f.io).catch(error => error);
  expect(result).toBe(original);
  expect(targetRecords(f.owner, "native-state")[0]).toMatchObject({ phase: "workload", target: null, value: { moment: "cancellation", state: { driver: null, safari: { kind: "none" }, cancellation: { aborted: true } } } });
  const count = f.owner.records.length;
  f.owner.snapshotNative("cancellation");
  expect(f.owner.records).toHaveLength(count);
  expect(getEventListeners(f.controller.signal, "abort")).toBeEmpty();
  await f.owner.finish();
  expect(f.owner.proof()).toMatchObject({ childrenJoined: true, writersClosed: true });
});

test("actual native wrapper returns the identical result after joined teardown without waiting for target death", async () => {
  const f = await fixture();
  const status = { status: "fail", error: "guest error" };
  f.io.stopDriver = async () => { await stop(f.driver); };
  f.io.stopApp = async () => { await stop(f.app); };
  const result = await f.owner.run(() => withNativeDriver(async () => { f.owner.attach({ pid: 101, birth: "7" }); return status; }, f.config, f.io));
  expect(result).toBe(status);
  expect(f.owner.proof()).toMatchObject({ state: "settled", eventCount: 0, cleanupCompleted: true });
  expect(JSON.parse(await readFile(f.config.cleanupFile, "utf8"))).toMatchObject({ driverExited: true, safariExited: true });
});

test.each(["queue", "prepare", "port", "spawn", "ready", "cancel"])("partial native construction at %s preserves the failure and attempts both teardown steps", async stage => {
  const f = await fixture();
  const original = new Error(`original ${stage}`);
  const fail = async () => { throw original; };
  if (stage === "queue") f.io.queue = fail;
  if (stage === "prepare" || stage === "cancel") {
    const prepare = f.io.prepare;
    f.io.prepare = async (...args) => { await prepare(...args); if (stage === "cancel") f.controller.abort(original); throw original; };
  }
  if (stage === "port") f.io.port = fail;
  if (stage === "spawn") f.io.spawn = () => { throw original; };
  if (stage === "ready") f.io.ready = fail;
  const result = await f.owner.run(() => withNativeDriver(async () => { throw new Error("workload admitted"); }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.events).toContain("app-stop");
  expect(f.owner.cleanup.map(step => step.phase)).toEqual(["driver-teardown", "app-teardown", "final-drain"]);
  expect(f.owner.proof()).toMatchObject({ descriptor: "not-opened", writersClosed: true });
});

test.each(["driver", "app"])("noncooperative %s teardown is bounded and remains unproved while later steps run", async stage => {
  const f = await fixture(100);
  const original = new Error("operation failed");
  const hang = () => new Promise<void>(() => {});
  if (stage === "driver") f.io.stopDriver = async () => { await stop(f.driver); return hang(); };
  if (stage === "app") f.io.stopApp = async () => { await stop(f.app); return hang(); };
  const result = await f.owner.run(() => withNativeDriver(async () => { f.owner.attach({ pid: 101, birth: "7" }); throw original; }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.owner.cleanup.at(-1)?.phase).toBe("final-drain");
  expect(f.owner.proof()).toMatchObject({ state: "unproved", childrenJoined: false, descriptor: "closed", writersClosed: true });
  expect(f.closes).toBe(1);
});
