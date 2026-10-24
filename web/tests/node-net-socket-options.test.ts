import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as util from "node:util";
import { runInNewContext } from "node:vm";

const runtime = new URL("../../crates/bunwasm-runtime/src/js/", import.meta.url);

function factory(name: string, extension = "js") {
  const source = readFileSync(new URL(`${name}.${extension}`, runtime), "utf8");
  const text = extension === "ts" ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`) : source;
  return runInNewContext(text, { Buffer, AbortController, AbortSignal });
}

function fixture() {
  const held = () => { throw new Error("Held transport, timer or lifecycle operation invoked"); };
  const native = new Proxy({}, { get: held });
  const processStub = { nextTick: held, env: {}, emitWarning: held };
  const address = factory("net_address")();
  const streamInternal = {
    builtin(name: string) {
      if (name === "node:process") return processStub;
      if (name === "node:buffer") return { Buffer };
      if (name === "node:events") return EventEmitter;
      if (name === "node:util") return util;
      return held();
    },
    require: held,
  };
  // Run the checked-in stream implementation, not the host's Duplex or a watermark model.
  const { Stream } = factory("node_stream_core")(streamInternal);
  const internal = {
    native,
    builtin(name: string) { if (name !== "node:stream") return held(); return Stream; },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "net_address") return address;
      if (name === "node_net_socket_options") return factory(name, "ts")();
      if (name === "node_net_server") return factory(name, "ts")(internal);
      return held();
    },
    nextTick: held,
  };
  const net: { Socket: new(options?: unknown) => { readableHighWaterMark: number; writableHighWaterMark: number; allowHalfOpen: boolean } } = factory("node_net")(internal)({
    Connection: held, addWaiter: held, waiters: new Set(), hostError: held,
    listenOrThrow: held, acceptLoop: held, trackServerConnection: held,
    closeNodeServer: held, disposeNodeServer: held,
  });
  return net;
}

test("Socket constructor honors independent readable and writable watermarks", () => {
  const { Socket } = fixture();
  const socket = new Socket({ readableHighWaterMark: 17, writableHighWaterMark: 23 });
  expect(socket.readableHighWaterMark).toBe(17);
  expect(socket.writableHighWaterMark).toBe(23);
  const readableOnly = new Socket({ readableHighWaterMark: 0 });
  expect(readableOnly.readableHighWaterMark).toBe(0);
  expect(readableOnly.writableHighWaterMark).toBe(65536);
  const writableOnly = new Socket({ writableHighWaterMark: 29 });
  expect(writableOnly.readableHighWaterMark).toBe(65536);
  expect(writableOnly.writableHighWaterMark).toBe(29);
});

test("Socket generic watermark still overrides both directions, including zero", () => {
  const { Socket } = fixture();
  for (const highWaterMark of [0, 31]) {
    const socket = new Socket({ highWaterMark, readableHighWaterMark: 17, writableHighWaterMark: 23 });
    expect(socket.readableHighWaterMark).toBe(highWaterMark);
    expect(socket.writableHighWaterMark).toBe(highWaterMark);
  }
});

test("Socket keeps null/default options, allowHalfOpen and caller option ownership", () => {
  const { Socket } = fixture();
  for (const options of [undefined, null, {}]) {
    const socket = new Socket(options);
    expect(socket.readableHighWaterMark).toBe(65536);
    expect(socket.writableHighWaterMark).toBe(65536);
    expect(socket.allowHalfOpen).toBe(false);
  }
  const options = Object.freeze({ readableHighWaterMark: 17, writableHighWaterMark: 23, allowHalfOpen: true });
  expect(new Socket(options).allowHalfOpen).toBe(true);
  expect(options).toEqual({ readableHighWaterMark: 17, writableHighWaterMark: 23, allowHalfOpen: true });
});

test("Socket still rejects invalid directional watermarks through the stream constructor", () => {
  const { Socket } = fixture();
  for (const options of [{ readableHighWaterMark: -1 }, { writableHighWaterMark: 1.5 }]) {
    expect(() => new Socket(options)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
  }
});
