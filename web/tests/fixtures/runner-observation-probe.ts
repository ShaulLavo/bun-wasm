import assert from "node:assert/strict";
import { rootObservationHost, containsStopFailure } from "./root-observation-host.ts";
import { captureProcessObserver, type ProcessObservation } from "waffle/proc/observation";
import { startRun } from "../../src/runner.ts";
import type { RunRequest } from "../../src/bun-executor.ts";
import { fixtureModule } from "../process-module-fixture.ts";

const mode = process.argv[2];
const NativeWorker = globalThis.Worker;
const workers: ControlledWorker[] = [];
const stop = Promise.withResolvers<void>();
const stopping = Promise.withResolvers<void>();
const observed = Promise.withResolvers<ProcessObservation>();
const posted = Promise.withResolvers<RunRequest>();
const gate = new Int32Array(new SharedArrayBuffer(8));
const failure = mode === "reject-falsy" ? undefined : new Error("controlled native stop failed");
let calls = 0;
let reenter = () => {};
class ControlledWorker extends NativeWorker {
  readonly root: boolean;
  constructor(url: string | URL, options?: WorkerOptions) {
    const root = !String(url).includes("fs-worker");
    super(root ? new URL("./runner-observation-worker.ts", import.meta.url) : new URL("../../src/fs-worker.ts", import.meta.url), options);
    this.root = root;
    workers.push(this);
    this.addEventListener("message", event => {
      if (event.data.type === "cpu-observed") observed.resolve(event.data.observation);
    });
  }
  override postMessage(request: RunRequest, options: Transferable[] | StructuredSerializeOptions = []) {
    const transfer = Array.isArray(options) ? options : options.transfer ?? [];
    if (!this.root) { super.postMessage(request, transfer); return; }
    posted.resolve(request);
    super.postMessage({ ...request, gate: gate.buffer }, transfer);
  }
  override terminate(): void | Promise<void> {
    if (!this.root) return super.terminate();
    calls++;
    stopping.resolve();
    reenter();
    if (mode === "throw") throw failure;
    if (mode === "reject" || mode === "reject-falsy") return Promise.reject(failure);
    if (mode === "void" || mode === "reentrant") return;
    if (mode === "fulfilled") return Promise.resolve();
    return stop.promise;
  }
  nativeStop() { return super.terminate(); }
}
const { runtime, restore } = rootObservationHost(ControlledWorker);
let disposal: Promise<void> | undefined;
try {
  const module = fixtureModule(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const run = startRun({ runtime, engine: "quickjs", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} });
  if (mode === "reentrant") reenter = () => { disposal ??= runtime.dispose(); };
  const request = await posted.promise;
  assert.ok(request.runtimeProcess);
  const observer = captureProcessObserver(request.runtimeProcess);
  assert.deepEqual(await run.done, { code: 0 }, "run.done remains independent of native return");
  await stopping.promise;
  const failed = mode === "throw" || mode === "reject" || mode === "reject-falsy";
  if (mode === "held" || failed) assert.equal(observer.read().kind, "selected");
  stop.resolve();
  await Promise.resolve();
  await Promise.resolve();
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  assert.equal((await observed.promise).kind, failed ? "selected" : "terminated", "late CPU observer follows native return, not logical collection");
  const result = await (disposal ??= runtime.dispose()).then(() => ({ kind: "disposed" as const }), error => ({ kind: "failed" as const, error }));
  assert.equal(result.kind, failed ? "failed" : "disposed");
  if (result.kind === "failed") assert.equal(containsStopFailure(result.error, failure), true, "native stop rejection keeps exact identity");
  assert.equal(calls, 1, "native stop is called once");
  console.log(`PASS CPU root observation ${mode}`);
} finally {
  stop.resolve();
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  await (disposal ?? runtime.dispose()).catch(() => {});
  await Promise.all(workers.map(worker => worker.nativeStop()));
  restore();
}
