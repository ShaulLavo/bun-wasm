import assert from "node:assert/strict";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";

const deadline = setTimeout(() => { throw new Error("queued close events did not finish"); }, 1000);
for (const web of [false, true]) {
  const { port1, port2 } = new MessageChannel();
  const messages: unknown[] = [];
  if (web) port2.onmessage = (event) => messages.push(event.data);
  else port2.on("message", (value) => messages.push(value));
  const closed = Promise.all([port1, port2].map((port) => new Promise<void>((resolve) => port.once("close", resolve))));
  port1.postMessage("queued-before-close");
  port2.close();
  port1.postMessage("queued-during-close");
  await closed;
  assert.deepEqual(messages, []);
  assert.equal(receiveMessageOnPort(port2), undefined);
  port2.start();
  port1.postMessage("after-close");
  assert.equal(receiveMessageOnPort(port2), undefined);
}
console.log("closed receivers drop queued Node and web messages");

const { port1, port2 } = new MessageChannel();
const messages: unknown[] = [];
const closed = Promise.all([port1, port2].map((port) => new Promise<void>((resolve) => port.once("close", resolve))));
port2.on("message", (value) => {
  messages.push(value);
  port2.close();
});
port1.postMessage(1);
port1.postMessage(2);
await closed;
assert.deepEqual(messages, [1, 2]);
console.log("an active delivery batch finishes before its close event");
clearTimeout(deadline);
