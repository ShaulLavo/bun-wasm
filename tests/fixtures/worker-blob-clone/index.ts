import assert from "node:assert/strict";
import { MessageChannel, Worker } from "node:worker_threads";
import { checkPayload, payload } from "./payload.ts";

const input = payload();
const cloned = structuredClone(input);
await checkPayload(cloned);
assert.notEqual(cloned.blob, input.blob);
console.log("structuredClone Blob bytes, type, methods and nested identity");

const channel = new MessageChannel();
try {
  const received = new Promise<ReturnType<typeof payload>>((resolve) => channel.port2.once("message", resolve));
  channel.port1.postMessage(input);
  channel.port1.close();
  await checkPayload(await received);
  console.log("MessageChannel Blob delivered before sender close");
} finally {
  channel.port1.close();
  channel.port2.close();
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
let exited = false;
const exit = new Promise<number>((resolve, reject) => {
  worker.once("exit", (code) => { exited = true; resolve(code); });
  worker.once("error", reject);
});
const reply = new Promise<ReturnType<typeof payload>>((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
});
try {
  worker.postMessage(input);
  await checkPayload(await reply);
  assert.equal(await exit, 0);
  console.log("Worker Blob workerData and round trip drain before natural exit");
} finally {
  if (!exited) await worker.terminate();
}
