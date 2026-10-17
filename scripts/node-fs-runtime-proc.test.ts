import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Completion = [error: unknown, count: number, buffer: Uint8Array];

// Evaluate the shipped fs implementation and the real net.js waiter scheduler. The only
// fake is the native boundary: runtime_proc reads return bytes, zero, or -WASI errno.
// All resources are per-fixture memory; no processes, timers or files need teardown.
function fixture(results: (Uint8Array | number)[], processAbi = true, networkingRead = true) {
  const immediate: (() => void)[] = [];
  const reads: [number, number][] = [];
  const syncReads: [number, number, number][] = [];
  const polls: Uint8Array[] = [];
  const contexts: string[] = [];
  let networkReads = 0;
  let context = "registration";
  let net: unknown;
  const internal: any = {
    native: {
      hostCaps: { proc_spawn: processAbi, read: networkingRead },
      getAsyncContext: () => context,
      procRead(fd: number, capacity: number) {
        reads.push([fd, capacity]);
        const result = results.shift() ?? 0;
        if (typeof result === "number") return result;
        const chunk = result.subarray(0, capacity);
        if (chunk.length < result.length) results.unshift(result.subarray(chunk.length));
        return chunk;
      },
      // These are networking slots, not process descriptors, even for handle zero.
      hostRead() { networkReads++; return -1; },
      procPoll(bytes: Uint8Array) { polls.push(bytes); return new Uint8Array(0); },
      read(fd: number, length: number, position: number) {
        syncReads.push([fd, length, position]);
        return Buffer.from("sync").subarray(0, length);
      },
      open: () => 0,
    },
    realTimers: { setImmediate: (fn: () => void) => immediate.push(fn) },
    describe: (value: unknown) => String(value),
    toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    concatBytes(parts: Uint8Array[]) { return Buffer.concat(parts); },
    web: { Request, Response, Headers, ReadableStream, DOMException },
    runInContext(saved: string, callback: (...args: unknown[]) => void, receiver: unknown, args: unknown[]) {
      contexts.push(saved);
      callback.apply(receiver, args);
    },
    require(name: string): unknown {
      if (name === "buffer") return { Buffer };
      if (name === "fs_watch") return () => ({});
      if (name === "http_common") return {};
      if (name === "websocket") return { clientClass: () => class {} };
      if (name === "net") return net ??= load("net")(internal);
      throw new Error(`Unexpected module ${name}`);
    },
  };
  function load(name: string) {
    return runInNewContext(readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.js`, import.meta.url), "utf8"), {
      Uint8Array, ArrayBuffer, DataView, URL, TextEncoder,
    });
  }
  const { fs } = load("node_fs")(internal);
  const flush = () => {
    while (immediate.length) immediate.shift()!();
  };
  return {
    fs, reads, syncReads, polls, contexts, immediate,
    networkReads: () => networkReads,
    setContext: (value: string) => { context = value; },
    pending: () => internal.ioPending?.() ?? 0,
    pump: () => internal.pumpIo(),
    wait: () => internal.ioWait(10),
    flush,
  };
}

function callback(results: Completion[]) {
  return (error: unknown, count: number, buffer: Uint8Array) => results.push([error, count, buffer]);
}

test("async stdin reads use process descriptors, preserve Buffer identity and async context", () => {
  const runtime = fixture([Buffer.from("abc")]);
  const buffer = Buffer.alloc(7, ".");
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, 2, 3, null, callback(results));
  runtime.setContext("polling");
  expect(results).toEqual([]);
  expect(runtime.pending()).toBe(1);
  expect(runtime.pump()).toBe(true);
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 3, buffer]]);
  expect(results[0]![2]).toBe(buffer);
  expect(buffer.toString()).toBe("..abc..");
  expect(runtime.contexts).toEqual(["registration"]);
  expect(runtime.reads).toEqual([[0, 3]]);
  expect(runtime.networkReads()).toBe(0);
  expect(runtime.syncReads).toEqual([]);
  expect(runtime.pending()).toBe(0);
});

test("generic stdin reads do not depend on the networking read slot being available", () => {
  const runtime = fixture([Buffer.from("proc")], true, false);
  const buffer = Buffer.alloc(4);
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, 0, 4, null, callback(results));
  expect(runtime.syncReads).toEqual([]);
  expect(runtime.pump()).toBe(true);
  runtime.flush();
  expect(results).toEqual([[null, 4, buffer]]);
  expect(buffer.toString()).toBe("proc");
  expect(runtime.reads).toEqual([[0, 4]]);
  expect(runtime.networkReads()).toBe(0);
});

test("partial stdin reads honor options and do not fill the whole requested length", () => {
  const runtime = fixture([Buffer.from("xy")]);
  const buffer = Buffer.alloc(6, ".");
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, { offset: 1, length: 4 }, callback(results));
  runtime.pump();
  runtime.flush();
  expect(results).toEqual([[null, 2, buffer]]);
  expect(buffer.toString()).toBe(".xy...");
  expect(runtime.reads).toEqual([[0, 4]]);
});

test("stdin reads respect a typed-array view's byte offset", () => {
  const runtime = fixture([Buffer.from("ok")]);
  const backing = new Uint8Array(8).fill(46);
  const view = backing.subarray(2, 6);
  const results: Completion[] = [];
  runtime.fs.read(0, view, 1, 2, null, callback(results));
  runtime.pump();
  runtime.flush();
  expect(results).toEqual([[null, 2, view]]);
  expect(Buffer.from(backing).toString()).toBe("...ok...");
});

test("EOF completes once with zero bytes without mutating the buffer", () => {
  const runtime = fixture([0]);
  const buffer = Buffer.from("keep");
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, 0, 4, null, callback(results));
  runtime.pump();
  runtime.flush();
  runtime.pump();
  runtime.flush();
  expect(results).toEqual([[null, 0, buffer]]);
  expect(buffer.toString()).toBe("keep");
  expect(runtime.pending()).toBe(0);
});

test("zero-length stdin reads complete later without consuming input or registering a waiter", () => {
  const runtime = fixture([Buffer.from("input")]);
  const buffer = Buffer.alloc(4);
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, 0, 0, null, callback(results));
  expect(results).toEqual([]);
  expect(runtime.pending()).toBe(0);
  runtime.flush();
  expect(results).toEqual([[null, 0, buffer]]);
  expect(runtime.reads).toEqual([]);
  expect(runtime.networkReads()).toBe(0);
});

test("WASI EAGAIN keeps the waiter and subscribes fd zero for process readiness", () => {
  const runtime = fixture([-6, -6, Buffer.from("ready")]);
  const buffer = Buffer.alloc(5);
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, 0, 5, null, callback(results));
  for (let turn = 0; turn < 2; turn++) {
    expect(runtime.pump()).toBe(false);
    runtime.flush();
    expect(results).toEqual([]);
    expect(runtime.pending()).toBe(1);
    expect(runtime.wait()).toBe(true);
  }
  expect(runtime.polls).toHaveLength(2);
  for (const subscription of runtime.polls) {
    expect(subscription).toHaveLength(16);
    expect(Array.from(subscription)).toEqual(new Array(16).fill(0)); // READABLE=0, fd=0, userdata=0
  }
  expect(runtime.pump()).toBe(true);
  runtime.flush();
  expect(results).toEqual([[null, 5, buffer]]);
  expect(buffer.toString()).toBe("ready");
  expect(runtime.pending()).toBe(0);
  expect(runtime.networkReads()).toBe(0);
});

for (const [wasi, code, errno] of [[2, "EACCES", -13], [4, "EADDRNOTAVAIL", -99], [8, "EBADF", -9], [27, "EINTR", -4], [28, "EINVAL", -22], [29, "EIO", -5], [52, "ENOSYS", -38]] as const) {
  test(`stdin -WASI ${wasi} reaches the callback as ${code}, not a legacy retry or sync fallback`, () => {
    const runtime = fixture([-wasi]);
    const buffer = Buffer.from("keep");
    const results: Completion[] = [];
    runtime.fs.read(0, buffer, 0, 4, null, callback(results));
    expect(runtime.pump()).toBe(true);
    expect(results).toEqual([]);
    runtime.flush();
    expect(results).toHaveLength(1);
    expect(results[0]![0]).toMatchObject({ code, errno, syscall: "read" });
    expect(results[0]![1]).toBe(0);
    expect(results[0]![2]).toBe(buffer);
    expect(buffer.toString()).toBe("keep");
    expect(runtime.pending()).toBe(0);
    expect(runtime.syncReads).toEqual([]);
    expect(runtime.networkReads()).toBe(0);
  });
}

test("non-stdin callback, readSync and FileHandle promise reads retain the synchronous WASI native", async () => {
  const runtime = fixture([]);
  const results: Completion[] = [];
  const buffer = Buffer.alloc(4);
  runtime.fs.read(5, buffer, 0, 4, 2, callback(results));
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 4, buffer]]);
  expect(runtime.fs.readSync(0, buffer, 0, 4, null)).toBe(4);
  const handle = await runtime.fs.promises.open("/stdin", "r");
  const result = await handle.read(buffer, 0, 4, null);
  expect(result).toEqual({ bytesRead: 4, buffer });
  expect(runtime.syncReads).toEqual([[5, 4, 2], [0, 4, -1], [0, 4, -1]]);
  expect(runtime.reads).toEqual([]);
  expect(runtime.networkReads()).toBe(0);
});

test("without the generic process ABI stdin uses the synchronous native, not networking slots", () => {
  const runtime = fixture([], false);
  const buffer = Buffer.alloc(4);
  const results: Completion[] = [];
  runtime.fs.read(0, buffer, 0, 4, null, callback(results));
  runtime.flush();
  expect(results).toEqual([[null, 4, buffer]]);
  expect(runtime.syncReads).toEqual([[0, 4, -1]]);
  expect(runtime.networkReads()).toBe(0);
});
