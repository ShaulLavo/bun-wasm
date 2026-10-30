// The child process of scripts/worker-group-startup.test.ts, on its own thread.
import { parentPort, workerData } from "node:worker_threads";
import { attach, counters, groupRuntime, type ChildSpec, type GroupBuffers } from "./group-runtime";

const { group: buffers, sources } = workerData as { group: GroupBuffers; sources?: string };
const group = attach(buffers);
parentPort!.once("message", (spec: ChildSpec) => {
  const member = groupRuntime({ group, pid: spec.pid, env: spec.env, sources });
  try {
    member.threads.initialize();
    const { sab } = member.threads.workerData as { sab: SharedArrayBuffer };
    parentPort!.postMessage({ value: new Int32Array(sab)[0], pins: counters(group).pins });
  } catch (error) {
    parentPort!.postMessage({ error: String(error) });
  } finally {
    member.loop.stop();
  }
});
parentPort!.postMessage("ready");
