import assert from "node:assert/strict";
import { BroadcastChannel, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

const sender = new BroadcastChannel("receive-validation");
const receiver = new BroadcastChannel("receive-validation");
try {
  assert.equal(receiveMessageOnPort(sender), undefined);
  assert.equal(receiveMessageOnPort(receiver), undefined);
  const message = new Promise<void>((resolve) => {
    receiver.onmessage = (event) => { assert.equal(event.data, 1); resolve(); };
  });
  sender.postMessage(1);
  assert.equal(receiveMessageOnPort(receiver), undefined);
  await message;
  for (const port of [{}, null, undefined]) {
    assert.throws(() => receiveMessageOnPort(port), { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
  }
} finally {
  sender.close();
  receiver.close();
}
const { port1, port2 } = new MessageChannel();
port1.postMessage(undefined);
assert.deepEqual(receiveMessageOnPort(port2), { message: undefined });
assert.equal(receiveMessageOnPort(port2), undefined);
port1.close();
port2.close();
console.log("receiveMessageOnPort accepts BroadcastChannel without consuming its messages");
