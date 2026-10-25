import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { bootstrap, preview1Executor } from "waffle/browser/worker";
import { linkedWorkerHooks } from "waffle/link";

assert(parentPort);
const port = parentPort;
const hooks = linkedWorkerHooks();
let constructors: (() => unknown) | undefined;
let finished = 0;

try {
  await bootstrap(workerData, {
    ...preview1Executor,
    ...hooks,
    instantiated({ instance, process }) {
      assert(process, "ordinary worker installed the real process ABI");
      const count = instance.exports.bun_core_ctor_count;
      assert.equal(typeof count, "function");
      if (typeof count !== "function") throw Error("constructor counter missing");
      constructors = () => count();
      assert.equal(count(), 0, "constructors do not run during instantiation");
    },
    initialize(context) {
      hooks.initialize?.(context);
      hooks.initialize?.(context);
      assert.equal(constructors?.(), 1);
    },
    beforeFinish() {
      assert.equal(constructors?.(), 1, "CLI entry did not repeat constructors");
      hooks.beforeFinish?.();
      finished++;
    },
  }, {
    crossOriginIsolated: true,
    postMessage(message) { port.postMessage(message); },
  });
  port.postMessage({ checkpoint: "cleanup", finished });
} finally {
  workerData.filesystem.port.close();
  port.close();
}
