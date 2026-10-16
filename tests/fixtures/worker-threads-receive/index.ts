import assert from "node:assert/strict";
import { BroadcastChannel, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

const sender = new BroadcastChannel("receive-validation");
const receiver = new BroadcastChannel("receive-validation");
try {
  sender.postMessage(1);
  for (const port of [sender, receiver, {}, null, undefined]) {
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
console.log("receiveMessageOnPort accepts only MessagePort");
