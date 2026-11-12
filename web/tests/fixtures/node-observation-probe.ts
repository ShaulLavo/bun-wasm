import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeProcessBroker } from "../../scripts/node-spawn.ts";
import { captureProcessObserver, type ProcessObservation } from "waffle/proc/observation";
import { WorkerProcessClient, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { DescriptorTable } from "waffle/core/descriptors";
import { containsStopFailure } from "./root-observation-host.ts";

const mode = process.argv[2];
const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-node-observation-"));
process.env.BUN_WASM_SCRATCH_ROOT = scratch;
const native = Promise.withResolvers<number>();
const failure = mode === "reject-falsy" ? null : new Error("Node native stop failed");
const workers: ControlledWorker[] = [];
const children = Promise.withResolvers<WorkerProcessTransport>();
const gates = new Int32Array(new SharedArrayBuffer(4));
let broker: NodeProcessBroker | undefined;
let disposal: Promise<void> | undefined;
class ControlledWorker extends Worker {
  calls = 0;
  readonly ready = Promise.withResolvers<void>();
  readonly observed = Promise.withResolvers<ProcessObservation>();
  constructor(transport: WorkerProcessTransport) {
    super(new URL("./node-observation-worker.ts", import.meta.url));
    workers.push(this);
    this.on("message", message => {
      if (message.type === "ready") this.ready.resolve();
      if (message.type === "observed") this.observed.resolve(message.observation);
    });
    this.postMessage({ transport, gate: gates.buffer });
  }
  override terminate(): Promise<number> {
    this.calls++;
    if (mode === "throw") throw failure;
    if (mode === "reject" || mode === "reject-falsy") return Promise.reject(failure);
    return native.promise;
  }
  nativeStop() { return super.terminate(); }
}
const descriptors = new DescriptorTable();
try {
  broker = new NodeProcessBroker({
    module: new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])),
    launch(_context, transport) { children.resolve(transport); return new ControlledWorker(transport); },
    onError() {},
  });
  const root = new ControlledWorker(broker.root);
  broker.attach(root, broker.root);
  const client = new WorkerProcessClient({ transport: { ...broker.root, resources: [], bindings: [] }, descriptors,
    codec: { export() { throw new Error("No descriptor export in Node observation control"); }, import() { throw new Error("No descriptor import in Node observation control"); }, discard() {} },
    postMessage: message => { void broker!.broker.handle(message, 1); },
  });
  const pid = client.spawn(1, { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/", job: -1, fds: [] });
  const child = await children.promise;
  assert.equal(child.pid, pid);
  const observations = [broker.root, child].map(captureProcessObserver);
  await Promise.all(workers.map(worker => worker.ready.promise));
  broker.supervisor.exit(1, 0);
  broker.supervisor.exit(pid, 7);
  disposal = broker.dispose();
  const settled = disposal.then(() => ({ kind: "disposed" as const }), error => ({ kind: "failed" as const, error }));
  for (const observer of observations) assert.equal(observer.read().kind, "selected");
  native.resolve(0);
  const result = await settled;
  const failed = mode === "throw" || mode === "reject" || mode === "reject-falsy";
  assert.equal(result.kind, failed ? "failed" : "disposed");
  if (result.kind === "failed") assert.equal(containsStopFailure(result.error, failure), true);
  Atomics.store(gates, 0, 1);
  Atomics.notify(gates, 0);
  for (const worker of workers) {
    assert.equal((await worker.observed.promise).kind, failed ? "selected" : "terminated");
    assert.equal(worker.calls, 1, "root and child native stop calls are idempotent");
  }
  assert.deepEqual(observations.map(observer => observer.read().kind), failed ? ["selected", "selected"] : ["terminated", "terminated"]);
  console.log(`PASS Node root and child observation ${mode}`);
} finally {
  native.resolve(0);
  Atomics.store(gates, 0, 1);
  Atomics.notify(gates, 0);
  await (disposal ?? broker?.dispose())?.catch(() => {});
  await Promise.all(workers.map(worker => worker.nativeStop()));
  descriptors.dispose();
  await rm(scratch, { recursive: true, force: true });
}
