import assert from "node:assert/strict";
import { parentPort, workerData, isMainThread, threadId, getEnvironmentData } from "node:worker_threads";
assert.ok(parentPort);
parentPort.once("message", () => {
  console.log("worker stdout");
  console.error("worker stderr");
  parentPort.postMessage({ isMainThread, threadId, byte: new Uint8Array(workerData.buffer)[0],
    cycle: workerData.self === workerData, map: workerData.map.get("key").has(2), env: process.env.WORKER_ONLY,
    argv: process.argv, inherited: getEnvironmentData("inherited") });
});
