// The child process of scripts/worker-group-startup.test.ts, on its own thread.
import { parentPort, workerData } from "node:worker_threads";
import { groupRuntime, PIN_OWNER } from "./group-runtime";

const { words, region } = workerData as { words: SharedArrayBuffer; region: SharedArrayBuffer };
const group = { words: new Int32Array(words), region };
parentPort!.once("message", ({ env }: { env: Record<string, string> }) => {
  try {
    const threads = groupRuntime({ group, pid: 2, env });
    threads.initialize();
    const { sab } = threads.workerData as { sab: SharedArrayBuffer };
    parentPort!.postMessage({ value: new Int32Array(sab)[0], owner: Atomics.load(group.words, PIN_OWNER) });
  } catch (error) {
    parentPort!.postMessage({ error: String(error) });
  }
});
parentPort!.postMessage("ready");
