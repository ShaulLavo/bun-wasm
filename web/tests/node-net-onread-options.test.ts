import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as util from "node:util";
import { runInNewContext } from "node:vm";

const runtime = new URL("../../crates/bunwasm-runtime/src/js/", import.meta.url);
type Delivery = { capacity(): number; deliver(chunk: Uint8Array): unknown };

function factory(name: string, extension = "js") {
  const source = readFileSync(new URL(`${name}.${extension}`, runtime), "utf8");
  const text = extension === "ts" ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`) : source;
  return runInNewContext(text, { Buffer, Uint8Array, AbortController, AbortSignal });
}

function fixture(handled = true) {
  const held = () => { throw new Error("Transport or lifecycle operation invoked in pure options test"); };
  const errors: unknown[] = [], exits: number[] = [];
  const internal = {
    native: { exit(code: number) { exits.push(code); } },
    handleUncaught(error: unknown) { errors.push(error); return handled; },
    builtin(name: string) {
      if (name === "node:stream") return Stream;
      return held();
    },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "net_address") return factory(name)();
      if (name === "node_net_onread") return onread;
      if (name === "node_net_socket_state") return factory(name, "ts")();
      if (name === "node_net_server") return factory(name, "ts")(internal);
      return held();
    },
    nextTick: held,
  };
  const { Stream } = factory("node_stream_core")({
    builtin(name: string) {
      if (name === "node:process") return { nextTick: held, env: {}, emitWarning: held };
      if (name === "node:buffer") return { Buffer };
      if (name === "node:events") return EventEmitter;
      if (name === "node:util") return util;
      return held();
    },
    require: held,
  });
  const onread: (options: unknown) => Delivery | null = factory("node_net_onread", "ts")(internal);
  const net: { Socket: new(options?: unknown) => unknown } = factory("node_net")(internal)({
    Connection: held, addWaiter: held, waiters: new Set(), hostError: held,
    listenOrThrow: held, acceptLoop: held, trackServerConnection: held,
    closeNodeServer: held, disposeNodeServer: held,
  });
  return { ...net, onread, errors, exits };
}

function delivery(options: unknown, handled = true) {
  const context = fixture(handled);
  const read = context.onread(options);
  if (!read) throw new Error("Expected callback reader");
  return { ...context, read };
}

test.each(["objectMode", "readableObjectMode", "writableObjectMode"])("Socket rejects truthy %s before Duplex", name => {
  const { Socket } = fixture();
  for (const value of [true, 1, "yes"]) {
    expect(() => new Socket({ [name]: value })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE", message: expect.stringContaining(name) }));
  }
  expect(() => new Socket({ [name]: false })).not.toThrow();
});

test("Socket reads enumerable onread once and leaves caller options unchanged", () => {
  const { Socket } = fixture();
  let reads = 0;
  const options = Object.freeze({ get onread() { if (++reads > 1) throw new Error("Second onread read"); return null; } });
  expect(() => new Socket(options)).not.toThrow();
  expect(reads).toBe(1);
  expect(() => new Socket(null)).not.toThrow();
});

test("onread rejects forged typed arrays and accepts genuine foreign Uint8Arrays", () => {
  const { onread } = fixture();
  expect(onread({ buffer: Object.create(Uint8Array.prototype), callback() {} })).toBeNull();
  const foreign: Uint8Array = runInNewContext("new Uint8Array(3)");
  const seen: unknown[] = [];
  const { read } = delivery({ buffer: foreign, callback(count: number, bytes: unknown) { seen.push(count, bytes); } });
  expect(read.capacity()).toBe(3);
  read.deliver(Uint8Array.of(7, 8));
  expect(Array.from(foreign)).toEqual([7, 8, 0]);
  expect(seen).toEqual([2, foreign]);
});

test("factory results use the genuine brand and retain a prior buffer on invalid results", () => {
  const foreign: Uint8Array = runInNewContext("new Uint8Array(4)");
  const buffers: unknown[] = [foreign, Object.create(Uint8Array.prototype), null];
  const { read } = delivery({ buffer: () => buffers.shift(), callback() { return false; } });
  expect(read.capacity()).toBe(4);
  expect(read.deliver(Uint8Array.of(1))).toBe(false);
  expect(read.capacity()).toBe(4);
  read.deliver(Uint8Array.of(2));
  expect(read.capacity()).toBe(4);
});

test("delivery reports post-callback factory errors and retains its buffer", () => {
  const failure = new Error("factory failed");
  let allocations = 0;
  const { read, errors, exits } = delivery({ buffer() { if (++allocations > 1) throw failure; return new Uint8Array(2); }, callback() {} });
  expect(() => read.deliver(Uint8Array.of(1))).not.toThrow();
  expect(errors).toEqual([failure]);
  expect(exits).toEqual([]);
  expect(read.capacity()).toBe(2);
});

test.each([true, false])("callback errors skip allocation, handled=%s", handled => {
  const failure = new Error("callback failed");
  let allocations = 0;
  const { read, errors, exits } = delivery({ buffer() { allocations++; return new Uint8Array(2); }, callback() { throw failure; } }, handled);
  read.deliver(Uint8Array.of(1));
  expect(allocations).toBe(1);
  expect(errors).toEqual([failure]);
  expect(exits).toEqual(handled ? [] : [1]);
});

test("initial factory errors remain synchronous and empty buffers keep ENOBUFS", () => {
  const failure = new Error("initial allocation");
  const { onread, errors } = fixture();
  expect(() => onread({ buffer() { throw failure; }, callback() {} })).toThrow(failure);
  expect(errors).toEqual([]);
  const { read } = delivery({ buffer: new Uint8Array(0), callback() {} });
  expect(() => read.capacity()).toThrow(expect.objectContaining({ code: "ENOBUFS", syscall: "read" }));
});
