import { expect, test } from "bun:test";
import { Socket } from "node:net";
import * as net from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { createNodeNet } from "../scripts/node-net.mjs";

class QueuedSocket extends Socket {
  queued = 0;
  constructor() { super(); Object.defineProperty(this, "writableLength", { get: () => this.queued }); }
  writes: Uint8Array[] = [];
  write(bytes: Uint8Array) {
    this.writes.push(bytes);
    this.queued += bytes.length;
    return false;
  }
  override end() { return this; }
}

function fixture() {
  const socket = new QueuedSocket();
  const { natives } = createNodeNet({ net: { ...net, connect: () => socket }, http, https, zlib });
  return { socket, natives, handle: natives.hostConnect("127.0.0.1", 1234) };
}

test("Node host writes stop at available queue capacity", () => {
  const { socket, natives, handle } = fixture();
  const capacity = 1 << 20;
  const bytes = new Uint8Array(capacity * 2).fill(7);
  expect(natives.hostWrite(handle, bytes)).toBe(capacity);
  expect(socket.writableLength).toBe(capacity);
  expect(natives.hostWrite(handle, bytes)).toBe(-2);
  expect(socket.writes.length).toBe(1);
  expect(natives.hostWrite(handle, new Uint8Array())).toBe(0);
  socket.queued = capacity - 3;
  expect(natives.hostWrite(handle, bytes)).toBe(3);
  bytes.fill(9);
  expect(Array.from(socket.writes[1] ?? [])).toEqual([7, 7, 7]);
  expect(natives.hostClose(handle)).toBe(0);
});
