import assert from "node:assert/strict";
import { markAsUntransferable } from "node:worker_threads";

type Sender = (value: unknown, transfer: unknown) => void;
type InvalidTransfer = { make(): unknown[]; name: string; message: string };

function memory() {
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]));
  return new WebAssembly.Instance(module).exports.memory;
}

export function checkTransferValidation(send: Sender) {
  let iteratorReads = 0;
  const transfer = { get [Symbol.iterator]() { iteratorReads++; return function* () { yield null; }; } };
  assert.throws(() => send(null, { transfer }), { name: "TypeError", message: "Type error" });
  assert.equal(iteratorReads, 1);
  const cloneError = "The object can not be cloned.";
  const cases: InvalidTransfer[] = [];
  for (const entry of [null, undefined, false, 1, "buffer", 1n, Symbol("buffer")]) {
    cases.push({ make: () => [entry], name: "TypeError", message: "Type error" });
    cases.push({ make: () => [{}, entry], name: "TypeError", message: "Type error" });
  }
  for (const make of [() => ({}), () => () => {}, () => new Uint8Array(1), () => new Blob(["x"]), () => Object.create(ArrayBuffer.prototype), () => memory()]) {
    cases.push({ make: () => [make()], name: "DataCloneError", message: cloneError });
  }
  cases.push({
    make() { const buffer = new ArrayBuffer(1); structuredClone(buffer, { transfer: [buffer] }); return [buffer]; },
    name: "DataCloneError", message: cloneError,
  }, {
    make() { const buffer = new ArrayBuffer(1); return [buffer, buffer]; },
    name: "DataCloneError", message: "Transfer list contains duplicate ArrayBuffer",
  }, {
    make() { const buffer = new ArrayBuffer(1); return [buffer, buffer, null]; },
    name: "TypeError", message: "Type error",
  }, {
    make() { const buffer = new ArrayBuffer(1); markAsUntransferable(buffer); return [buffer]; },
    name: "DataCloneError", message: "Cannot transfer object marked as untransferable",
  }, {
    make: () => [memory().buffer],
    name: "TypeError", message: "Cannot transfer a WebAssembly.Memory",
  });
  const channel = new MessageChannel();
  cases.push({ make: () => [channel.port1, channel.port1], name: "DataCloneError", message: "Transfer list contains duplicate MessagePort" });
  try {
    for (const test of cases) checkInvalidTransfer(send, test);
    for (const options of [false, true]) {
      const buffer = new ArrayBuffer(16);
      const empty = new ArrayBuffer(0);
      const transfer = [buffer, empty];
      send(null, options ? { transfer } : transfer);
      assert.equal(buffer.byteLength, 0);
    }
    const received = new Promise(resolve => { channel.port2.onmessage = event => resolve(event.data); });
    channel.port1.postMessage("still owned");
    return received.then(value => assert.equal(value, "still owned")).finally(() => { channel.port1.close(); channel.port2.close(); });
  } catch (error) {
    channel.port1.close(); channel.port2.close(); throw error;
  }
}

function checkInvalidTransfer(send: Sender, test: InvalidTransfer) {
  for (const options of [false, true]) {
    for (const first of [false, true]) {
      const buffer = new ArrayBuffer(16);
      const prefix: unknown[] = [buffer];
      const transfer = first ? prefix.concat(test.make()) : test.make().concat(prefix);
      let serialized = false;
      const value = { get payload() { serialized = true; return buffer; } };
      assert.throws(() => send(value, options ? { transfer } : transfer), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, test.name);
        assert.equal(error.constructor.name, test.name === "TypeError" ? "TypeError" : "DOMException");
        assert.equal(error.message, test.message);
        return true;
      });
      assert.equal(buffer.byteLength, 16);
      assert.equal(serialized, false);
    }
  }
}
