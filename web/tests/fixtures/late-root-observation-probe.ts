import assert from "node:assert/strict";
import { rootObservationHost, containsStopFailure } from "./root-observation-host.ts";
import type { ProcessService } from "waffle";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { captureProcessObserver, type ProcessObservation } from "waffle/proc/observation";
import type { ProcessRuntime } from "../../../src/process-runtime.ts";
import { startRun } from "../../src/runner.ts";
import { fixtureModule } from "../process-module-fixture.ts";

const mode = process.argv[2];
const NativeWorker = globalThis.Worker;
const acquired = Promise.withResolvers<void>();
const acquisition = Promise.withResolvers<void>();
const stopping = Promise.withResolvers<void>();
const native = Promise.withResolvers<void>();
const inspected = Promise.withResolvers<ProcessObservation>();
const ready = Promise.withResolvers<void>();
const gate = new Int32Array(new SharedArrayBuffer(4));
const workers: ControlledWorker[] = [];
const failure = mode === "reject-falsy" ? false : new Error("late native stop failed");
let calls = 0, posts = 0;
class ControlledWorker extends NativeWorker {
  readonly root: boolean;
  constructor(url: string | URL, options?: WorkerOptions) {
    const root = !String(url).includes("fs-worker");
    super(root ? new URL("./late-root-observation-worker.ts", import.meta.url) : new URL("../../src/fs-worker.ts", import.meta.url), options);
    this.root = root;
    workers.push(this);
    if (root) this.addEventListener("message", event => {
      if (event.data.type === "cpu-ready") ready.resolve();
      if (event.data.type === "cpu-observed") inspected.resolve(event.data.observation);
    });
  }
  override postMessage(value: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
    const transfer = Array.isArray(options) ? options : options.transfer ?? [];
    if (this.root) posts++;
    super.postMessage(value, transfer);
  }
  inspect(transport: ReturnType<typeof createWorkerProcessTransport>) { super.postMessage({ transport, gate: gate.buffer }); }
  override terminate(): void | Promise<void> {
    if (!this.root) return super.terminate();
    calls++;
    stopping.resolve();
    if (mode === "throw") throw failure;
    if (mode === "reject" || mode === "reject-falsy") return Promise.reject(failure);
    if (mode === "void") return;
    if (mode === "fulfilled") return Promise.resolve();
    return native.promise;
  }
  nativeStop() { return super.terminate(); }
}
const { runtime, restore } = rootObservationHost(ControlledWorker);
let disposal: Promise<void> | undefined;
try {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const observer = captureProcessObserver(transport);
  const borrowing: ProcessRuntime = Object.create(runtime);
  Object.defineProperty(borrowing, "processes", { value: async () => {
    const taken = service.takeWorker("https://example.test/worker.js");
    assert.ok(taken instanceof ControlledWorker);
    taken.inspect(transport);
    const view: ProcessService = Object.create(service);
    Object.defineProperty(view, "takeWorker", { value: () => taken });
    acquired.resolve();
    await acquisition.promise;
    return view;
  } });
  const module = fixtureModule(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const run = startRun({ runtime: borrowing, runtimeProcess: transport, engine: "quickjs", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} });
  await acquired.promise;
  await ready.promise;
  let disposed = false;
  const result = (disposal = runtime.dispose()).then(() => { disposed = true; return { kind: "disposed" as const }; }, error => ({ kind: "failed" as const, error }));
  assert.deepEqual(await run.done, { code: 137 });
  assert.equal(calls, 0, "a pending acquisition cannot be stopped or certified yet");
  assert.equal(disposed, false, "disposal retains asynchronous acquisition");
  acquisition.resolve();
  await stopping.promise;
  const failed = mode === "throw" || mode === "reject" || mode === "reject-falsy";
  if (mode === "held" || failed) assert.equal(observer.read().kind, "selected");
  native.resolve();
  const settled = await result;
  assert.equal(settled.kind, failed ? "failed" : "disposed");
  if (settled.kind === "failed") assert.equal(containsStopFailure(settled.error, failure), true, "native rejection identity is unchanged");
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  assert.equal((await inspected.promise).kind, failed ? "selected" : "terminated");
  assert.equal(calls, 1);
  assert.equal(posts, 0, "late acquisition must never post a guest start");
  console.log(`PASS late CPU root observation ${mode}`);
} finally {
  acquisition.resolve();
  native.resolve();
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  await (disposal ?? runtime.dispose()).catch(() => {});
  await Promise.all(workers.map(worker => worker.nativeStop()));
  restore();
}
// Failed disposal deliberately retains page ownership. This subprocess owns that page.
process.exit(0);
