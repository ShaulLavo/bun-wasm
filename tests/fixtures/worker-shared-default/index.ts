import assert from "node:assert/strict";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

const shared = new SharedArrayBuffer(8);
new Uint8Array(shared)[0] = 42;
const channel = new MessageChannel();
const input = { shared, alias: shared, view: new Uint8Array(shared) };
try {
  if (process.env.BUNWASM_TEST_HOST === "native") {
    assert.throws(() => channel.port1.postMessage(input), { name: "DataCloneError" });
    assert.equal(receiveMessageOnPort(channel.port2), undefined);
  } else {
    channel.port1.postMessage(input);
    const received = receiveMessageOnPort(channel.port2)?.message;
    assert.equal(received.alias, received.shared);
    assert.equal(received.view.buffer, received.shared);
    received.view[1] = 53;
    assert.equal(new Uint8Array(shared)[1], 53);
  }
  channel.port1.postMessage("recovered");
  assert.deepEqual(receiveMessageOnPort(channel.port2), { message: "recovered" });
  console.log("default shared buffer policy");
} finally {
  channel.port1.close();
  channel.port2.close();
}

let worker: Worker | undefined;
try {
  if (process.env.BUNWASM_TEST_HOST === "native") {
    assert.throws(() => {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
    }, { name: "DataCloneError" });
  } else {
    const running = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
    worker = running;
    const value = await new Promise<number>((resolve, reject) => {
      running.once("message", resolve);
      running.once("error", reject);
    });
    assert.equal(value, 42);
  }
  console.log("default worker data policy");
} finally {
  await worker?.terminate();
}
