import { expect, test } from "bun:test";
import { isNotificationBridgeRequest } from "./notification-worker-fixture";

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
