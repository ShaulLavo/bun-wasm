import assert from "node:assert/strict";
import { MessageChannel, MessagePort, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";

function inspect(value: unknown) {
  if (typeof value === "string") {
    assert.equal(value, "x".repeat(2 * 1024 * 1024));
    return { textBytes: new TextEncoder().encode(value).byteLength };
  }
  if (value instanceof ArrayBuffer) {
    assert.equal(value.byteLength, 800 * 1024);
    assert.ok(new Uint8Array(value).every(byte => byte === 23));
    return { bufferBytes: value.byteLength };
  }
  assert.ok(value && typeof value === "object" && "text" in value && "buffer" in value && "port" in value);
  assert.equal(value.text, "λ".repeat(1024 * 1024));
  assert.ok(value.buffer instanceof ArrayBuffer && value.port instanceof MessagePort);
  assert.deepEqual(Array.from(new Uint8Array(value.buffer)), [2, 3, 5, 7]);
  value.port.postMessage("reply from new owner");
  value.port.close();
  return { textBytes: new TextEncoder().encode(String(value.text)).byteLength, bufferBytes: value.buffer.byteLength, portMoved: true };
}

async function run(kind: "text" | "transfer" | "binary") {
  const channel = new MessageChannel(), reply = new MessageChannel();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const child = new Worker(new URL(import.meta.url), { workerData: { port: channel.port2, gate }, transferList: [channel.port2] });
  const result = Promise.withResolvers<unknown>();
  const failure = Promise.withResolvers<never>();
  const deadline = setTimeout(() => failure.reject(new Error("Native large-message control timed out")), 5000);
  child.on("error", failure.reject);
  const response = kind === "transfer" ? new Promise(resolve => reply.port1.once("message", resolve)) : Promise.resolve(null);
  try {
    await Promise.race([new Promise<void>(resolve => child.once("message", () => resolve())), failure.promise]);
    child.once("message", result.resolve);
    channel.port1.postMessage("before");
    const buffer = kind === "binary" ? new ArrayBuffer(800 * 1024) : new Uint8Array([2, 3, 5, 7]).buffer;
    if (kind === "binary") new Uint8Array(buffer).fill(23);
    if (kind === "text") channel.port1.postMessage("x".repeat(2 * 1024 * 1024));
    if (kind === "transfer") channel.port1.postMessage({ text: "λ".repeat(1024 * 1024), buffer, port: reply.port2 }, [buffer, reply.port2]);
    if (kind === "binary") channel.port1.postMessage(buffer, [buffer]);
    if (kind !== "text") assert.equal(buffer.byteLength, 0);
    channel.port1.postMessage("after");
    Atomics.store(gate, 0, 1);
    const notified = Atomics.notify(gate, 0);
    const observed = await Promise.race([result.promise, failure.promise]);
    if (kind === "transfer") assert.equal(await Promise.race([response, failure.promise]), "reply from new owner");
    console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, kind, notified, observed }));
  } finally {
    clearTimeout(deadline);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await child.terminate();
    channel.port1.close(); channel.port2.close(); reply.port1.close(); reply.port2.close();
  }
}

if (isMainThread) {
  await run("text");
  await run("transfer");
  await run("binary");
} else {
  const data: unknown = workerData;
  assert.ok(data && typeof data === "object" && "port" in data && "gate" in data);
  assert.ok(data.port instanceof MessagePort && data.gate instanceof Int32Array && parentPort);
  const port = data.port;
  parentPort.postMessage("ready");
  const waited = Atomics.wait(data.gate, 0, 0, 5000);
  assert.notEqual(waited, "timed-out");
  assert.deepEqual(receiveMessageOnPort(port), { message: "before" });
  const message = receiveMessageOnPort(port);
  assert.ok(message);
  const observed = inspect(message.message);
  assert.deepEqual(receiveMessageOnPort(port), { message: "after" });
  assert.equal(receiveMessageOnPort(port), undefined);
  parentPort.postMessage({ ...observed, waited, ordered: true, exactlyOnce: true, synchronousAfterWake: true });
  port.close();
}
