import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "waffle";
import { captureNativeReturn, captureProcessObserver } from "waffle/proc/observation";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { browserBuildConfig } from "../../../scripts/browser-build.ts";
import type { RunRequest } from "../../src/bun-executor.ts";

const mode = process.argv[2];
const gate = new Int32Array(new SharedArrayBuffer(8));
const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-entry-observation-"));
let worker: Worker | undefined;
const runtime = createRuntime({ filesystem: { workerURL: new URL("../../src/fs-worker.ts", import.meta.url), mode: "memory" } });
const filesystem = runtime.filesystem.fork();
try {
  const source = new URL("../../src/worker.ts", import.meta.url).pathname;
  const config = browserBuildConfig([source], scratch);
  config.plugins = (config.plugins ?? []).concat([{ name: "held-bun-import", setup(build) {
    build.onResolve({ filter: /(?:bun-terminal|nested\/host)\.js$/ }, () => ({ path: new URL("./worker-entry-import.ts", import.meta.url).pathname }));
  } }]);
  const build = await Bun.build(config);
  assert.equal(build.success, true, String(build.logs));
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  transport.data = { filesystem, ...(mode?.startsWith("terminal") ? { terminalContext: {} } : {}) };
  await service.adoptRuntimeRoot(transport, { memory: mode?.startsWith("nested") ? "group" : [], filesystem });
  const group = mode?.startsWith("nested") ? service.admitRootMemoryGroup(transport.pid) : undefined;
  const release = service.retainRoot(transport.pid);
  const observer = captureProcessObserver(transport);
  const returned = captureNativeReturn(transport);
  const completed = Promise.withResolvers<void>();
  const messages: { type: string; code?: number; signal?: number }[] = [];
  worker = new Worker(new URL("./worker-entry-observation-worker.ts", import.meta.url));
  worker.addEventListener("error", event => completed.reject(event));
  worker.addEventListener("message", event => {
    messages.push(event.data);
    if (event.data.type === "entry-finished") completed.resolve();
  });
  const request: RunRequest = {
    controlGrant: service.rootControlGrant(transport.pid), module: new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])),
    engine: "quickjs", args: [], env: {}, trace: false, net: null, runtimeProcess: transport, filesystem,
    memoryGroup: group?.request,
  };
  const transfers: Transferable[] = [filesystem.port];
  worker.postMessage({ entry: join(scratch, "worker.js"), request, gate: gate.buffer }, transfers.concat(group ? Array.from(group.transfer) : []));
  await Atomics.waitAsync(gate, 0, 0).value;
  assert.equal(Atomics.load(gate, 0), 1, "real Bun import is held");
  await service.killJob(workerProcessState(transport).job, 15);
  await service.rootExit(transport.pid, 143);
  if (mode?.endsWith("terminated")) returned();
  assert.equal(observer.read().kind, mode?.endsWith("terminated") ? "terminated" : "selected");
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  await completed.promise;
  assert.equal(messages.some(message => message.type === "executor-environment"), false, "terminal process must not construct the Bun executor after imports");
  const exits = messages.filter(message => message.type === "exit" || message.type === "error");
  assert.deepEqual(exits.map(message => ({ type: message.type, code: message.code, signal: message.signal })), mode?.endsWith("terminated") ? [] : [{ type: "exit", code: 143, signal: 15 }]);
  returned();
  release();
  if (group) group.stopped();
  else service.rootStopped(transport.pid);
  console.log(`PASS held Bun entry import ${mode}`);
} finally {
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  await worker?.terminate();
  filesystem.port.close();
  await runtime.dispose().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
