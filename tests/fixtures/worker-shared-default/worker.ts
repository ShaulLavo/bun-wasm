import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";

assert.equal(workerData.shared, workerData.alias);
assert.equal(workerData.view.buffer, workerData.shared);
assert(parentPort);
parentPort.postMessage(workerData.view[0]);
