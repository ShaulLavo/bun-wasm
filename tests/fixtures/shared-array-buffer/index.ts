// SharedArrayBuffer within one guest. Guests cannot share memory, so sending one is refused.
import { Worker } from "node:worker_threads";

const shared = new SharedArrayBuffer(16);
const view = new Int32Array(shared);
view[0] = 5;
view[3] = 9;
console.log("constructor", typeof SharedArrayBuffer, Object.prototype.toString.call(shared), shared.byteLength);
console.log("view", Array.from(view).join(","), new Int32Array(shared, 12, 1)[0]);
console.log("slice", Object.prototype.toString.call(shared.slice(4)), shared.slice(4).byteLength);

const worker = new Worker("require('node:worker_threads').parentPort.once('message', m => require('node:worker_threads').parentPort.postMessage(typeof m))", { eval: true });
try {
  worker.postMessage(shared);
  console.log("sent", await new Promise(resolve => worker.once("message", resolve)));
} catch (error) {
  console.log("send", (error as Error).name);
}
await worker.terminate();
