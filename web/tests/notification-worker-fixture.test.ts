import { expect, test } from "bun:test";
import { answerNotificationRelayDrop, isNotificationBridgeRequest } from "./notification-worker-fixture";

test("notification bridge accepts the public packet with an actual MessagePort", () => {
  const channel = new MessageChannel();
  try {
    const packet: unknown = { port: channel.port1, state: new Int32Array(new SharedArrayBuffer(8)) };
    expect(isNotificationBridgeRequest(packet)).toBe(true);
  } finally { channel.port1.close(); channel.port2.close(); }
});

test("notification bridge rejects a fake port and null", () => {
  expect(isNotificationBridgeRequest({ port: "x", state: 0 })).toBe(false);
  expect(isNotificationBridgeRequest(null)).toBe(false);
});

test("notification bridge rejects a process request with its nested filesystem port", () => {
  const channel = new MessageChannel();
  try {
    const request = {
      engine: "quickjs", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      args: ["bun"], env: {}, filesystem: { port: channel.port1 },
    };
    expect(isNotificationBridgeRequest(request)).toBe(false);
  } finally { channel.port1.close(); channel.port2.close(); }
});

test("a relay drop is answered as dropped and a run request is not", async () => {
  const answers: unknown[] = [];
  const worker = { onmessage: (event: { data: unknown }) => { answers.push(event.data); } };
  expect(answerNotificationRelayDrop(worker, { drop: 7 })).toBe(true);
  expect(answerNotificationRelayDrop(worker, { engine: "quickjs", args: [] })).toBe(false);
  expect(answerNotificationRelayDrop(worker, null)).toBe(false);
  await Promise.resolve();
  expect(answers).toEqual([{ id: 7, type: "dropped" }]);
});
