import assert from "node:assert/strict";
import { createRuntime } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { FilesystemService, MemoryBackend, type FilesystemConnection } from "waffle/fs";
import { workerProcessState } from "waffle/proc/worker-client";
import { startRun } from "../../src/runner.ts";
import type { RunRequest, WorkerMessage } from "../../src/bun-executor.ts";
import { fixtureModule } from "../process-module-fixture.ts";

type Mode = "synchronous" | "delayed" | "rejected";
type Disposal = { kind: "disposed" } | { kind: "failed"; error: unknown };
interface State {
  mode: Mode;
  barrier: ReturnType<typeof Promise.withResolvers<void>>;
  posted: ReturnType<typeof Promise.withResolvers<StopWorker>>;
  joined: ReturnType<typeof Promise.withResolvers<void>>;
  workers: StopWorker[];
  ports: MessagePort[];
  receipts: number[];
  physicallyStopped: boolean;
  broker?: BrowserProcessBroker;
}
class StopWorker {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  request?: RunRequest;
  service = new FilesystemService(new MemoryBackend());
  constructor(_url: string | URL, private state: State) { state.workers.push(this); }
  addEventListener() {}
  postMessage(message: RunRequest | { connect: FilesystemConnection }) {
    if ("connect" in message) { this.state.ports.push(message.connect.port); this.service.connect(message.connect); return; }
    this.request = message;
    this.state.posted.resolve(this);
  }
  terminate(): void | Promise<void> {
    if (!this.request) return;
    if (this.state.mode === "synchronous") { this.state.physicallyStopped = true; return; }
    return this.state.barrier.promise.then(() => { this.state.physicallyStopped = true; });
  }
}
function trackBroker(options: ConstructorParameters<typeof BrowserProcessBroker>[0], state: State): BrowserProcessBroker {
  const broker = new BrowserProcessBroker(options);
  state.broker = broker;
  const stopped = broker.rootStopped.bind(broker);
  broker.rootStopped = pid => { if (!state.receipts.includes(pid)) state.receipts.push(pid); stopped(pid); };
  const adopt = broker.adoptRuntimeRoot.bind(broker);
  broker.adoptRuntimeRoot = (transport, options) => adopt(transport, { ...options, stop() {
    state.joined.resolve();
    return options.stop?.();
  } });
  return broker;
}
function install(mode: Mode) {
  const state: State = { mode, barrier: Promise.withResolvers<void>(), posted: Promise.withResolvers<StopWorker>(), joined: Promise.withResolvers<void>(),
    workers: [], ports: [], receipts: [], physicallyStopped: false };
  const previous = new Map(["Worker", "location", "crossOriginIsolated"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class OwnedWorker extends StopWorker { constructor(url: string | URL) { super(url, state); } }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: OwnedWorker });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs-worker.js", mode: "memory" }, processHost: options => trackBroker(options, state) });
  return { state, runtime, previous };
}
function contains(error: unknown, reason: Error): boolean {
  if (error === reason) return true;
  if (!(error instanceof AggregateError)) return false;
  return error.errors.some((entry: unknown) => contains(entry, reason));
}
async function cleanup(probe: ReturnType<typeof install>): Promise<void> {
  probe.state.barrier.resolve();
  await probe.runtime.dispose().catch(() => {});
  for (const worker of probe.state.workers) { worker.request?.filesystem.port.close(); worker.service.dispose(); }
  for (const port of probe.state.ports) port.close();
  for (const [key, descriptor] of probe.previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
const mode = process.argv[2];
if (mode !== "synchronous" && mode !== "delayed" && mode !== "rejected") throw new Error("Expected physical stop mode");
const probe = install(mode);
try {
  const module = fixtureModule(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const run = startRun({ runtime: probe.runtime, engine: "quickjs", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} });
  const worker = await probe.state.posted.promise;
  const request = worker.request;
  assert.ok(request?.runtimeProcess);
  const pid = workerProcessState(request.runtimeProcess).pid;
  const broker = probe.state.broker;
  assert.ok(broker);
  worker.onmessage?.(new MessageEvent<WorkerMessage>("message", { data: { type: "exit", code: 0 } }));
  assert.deepEqual(await run.done, { code: 0 });
  let disposalSettled = false;
  const settlement = probe.runtime.dispose().then<Disposal, Disposal>(
    () => { disposalSettled = true; return { kind: "disposed" }; },
    (error: unknown) => { disposalSettled = true; return { kind: "failed", error }; },
  );
  if (mode !== "synchronous") {
    assert.equal(await Promise.race([probe.state.joined.promise.then(() => "joined"), settlement.then(() => "disposed")]), "joined", "runtime disposal lost its pending root stop");
    assert.equal(disposalSettled, false);
    assert.equal(probe.state.physicallyStopped, false);
    assert.strictEqual(broker.rootControlGrant(pid), request.controlGrant);
  }
  const failure = new Error("controlled physical stop rejection");
  if (mode === "rejected") probe.state.barrier.reject(failure);
  else probe.state.barrier.resolve();
  const result = await settlement;
  if (result.kind === "failed") {
    assert.equal(mode, "rejected");
    assert.ok(contains(result.error, failure));
    assert.strictEqual(broker.rootControlGrant(pid), request.controlGrant);
    assert.deepEqual(probe.state.receipts, []);
  } else {
    assert.notEqual(mode, "rejected");
    assert.equal(probe.state.physicallyStopped, true);
    assert.deepEqual(probe.state.receipts, [pid]);
    assert.throws(() => broker.rootControlGrant(pid), /Root is not admitted/);
  }
  console.log(`PASS manual root stop ${mode}`);
} finally {
  await cleanup(probe);
}
