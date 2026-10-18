import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Completion = [error: unknown, count: number, buffer: Uint8Array];

// Evaluate the shipped fs implementation and the real net.js waiter scheduler. The only
// fake is the native boundary: runtime_proc reads return bytes, zero, or -WASI errno.
// All resources are per-fixture memory; no processes, timers or files need teardown.
function fixture(results: (Uint8Array | number)[], processAbi = true, networkingRead = true, mode = 0o010000) {
  const immediate: (() => void)[] = [];
  const reads: [number, number][] = [];
  const syncReads: [number, number, number][] = [];
  const polls: Uint8Array[] = [];
  const contexts: string[] = [];
  const closed = new Set<number>();
  const checkFd = (fd: number) => {
    if (closed.has(fd)) throw Object.assign(new Error("read EBADF"), { code: "EBADF" });
  };
  let networkReads = 0;
  let context = "registration";
  let net: unknown;
  const internal: any = {
    native: {
      hostCaps: { proc_spawn: processAbi, read: networkingRead },
      getAsyncContext: () => context,
      procRead(fd: number, capacity: number) {
        reads.push([fd, capacity]);
        if (closed.has(fd)) return -8;
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
        checkFd(fd);
        return Buffer.from("sync").subarray(0, length);
      },
      write(fd: number, bytes: Uint8Array | string) { checkFd(fd); return bytes.length; },
      writev(fd: number, buffers: Uint8Array[]) { checkFd(fd); return buffers.reduce((n, buffer) => n + buffer.length, 0); },
      close(fd: number) { checkFd(fd); closed.add(fd); },
      open: () => 0,
      fstat(fd: number) { checkFd(fd); return { mode }; },
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
  expect(runtime.fs.readSync(1000000, Buffer.alloc(0))).toBe(0);
  expect(runtime.syncReads).toEqual([[5, 4, 2], [0, 4, -1]]);
  const handle = await runtime.fs.promises.open("/stdin", "r");
  const result = await handle.read(buffer, 0, 4, null);
  expect(result).toEqual({ bytesRead: 4, buffer });
  expect(runtime.syncReads).toEqual([[5, 4, 2], [0, 4, -1], [0, 4, -1]]);
  expect(runtime.reads).toEqual([]);
  expect(runtime.networkReads()).toBe(0);
});

test("public empty-length I/O matches native Node and Bun on closed descriptors", async () => {
  type Row = { name: string; expected: number | string; run(fs: any, fd: number): unknown };
  const readAsync = (fs: any, fd: number, buffer: Buffer, length: number) => new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, length, null, (error: unknown, count: number) => error ? reject(error) : resolve(count));
  });
  // Node 26.7.0 and Bun 1.4.2 agree on every row. The readv [] disagreement
  // (Bun: 0, Node: EINVAL) stays in node-fs-readv.test.ts, outside this shared table.
  const baseRows: Row[] = [
    { name: "readSync empty buffer", expected: 0, run: (fs, fd) => fs.readSync(fd, Buffer.alloc(0)) },
    { name: "readSync zero length", expected: 0, run: (fs, fd) => fs.readSync(fd, Buffer.alloc(4), 0, 0, null) },
    { name: "readSync options zero length", expected: 0, run: (fs, fd) => fs.readSync(fd, Buffer.alloc(4), { offset: 2, length: 0 }) },
    { name: "read callback empty buffer", expected: 0, run: (fs, fd) => readAsync(fs, fd, Buffer.alloc(0), 0) },
    { name: "read callback zero length", expected: 0, run: (fs, fd) => readAsync(fs, fd, Buffer.alloc(4), 0) },
    { name: "writeSync empty buffer", expected: "EBADF", run: (fs, fd) => fs.writeSync(fd, Buffer.alloc(0)) },
    { name: "writeSync empty string", expected: "EBADF", run: (fs, fd) => fs.writeSync(fd, "") },
    { name: "writeSync zero length", expected: "EBADF", run: (fs, fd) => fs.writeSync(fd, Buffer.alloc(4), 0, 0) },
    { name: "writevSync empty array", expected: 0, run: (fs, fd) => fs.writevSync(fd, []) },
    { name: "writevSync empty buffer", expected: "EBADF", run: (fs, fd) => fs.writevSync(fd, [Buffer.alloc(0)]) },
    { name: "writevSync two empty buffers", expected: "EBADF", run: (fs, fd) => fs.writevSync(fd, [Buffer.alloc(0), Buffer.alloc(0)]) },
    { name: "closed FileHandle empty read", expected: "EBADF", run: async (fs) => {
      const handle = await fs.promises.open("/file", "r");
      await handle.close();
      return (await handle.read(Buffer.alloc(0), 0, 0, null)).bytesRead;
    } },
  ];
  const argumentCases: [string, unknown[], number | string][] = [
    ["invalid buffer", [{ byteLength: 0 }, 0, 0, null], "ERR_INVALID_ARG_TYPE"],
    ["negative offset", [Buffer.alloc(4), -1, 0, null], "ERR_OUT_OF_RANGE"],
    ["fractional offset", [Buffer.alloc(4), 0.5, 0, null], "ERR_OUT_OF_RANGE"],
    ["string offset", [Buffer.alloc(4), "0", 0, null], "ERR_INVALID_ARG_TYPE"],
    ["negative length", [Buffer.alloc(4), 0, -1, null], "ERR_OUT_OF_RANGE"],
    ["empty buffer positive length", [Buffer.alloc(0), 0, 1, null], "ERR_INVALID_ARG_VALUE"],
    ["zero length beyond buffer", [Buffer.alloc(4), 5, 0, null], 0],
    ["zero length beyond empty buffer", [Buffer.alloc(0), 1, 0, null], 0],
  ];
  const rows = baseRows.concat(argumentCases.flatMap<Row>(([name, args, expected]) => [
    { name: `readSync ${name}`, expected, run: (fs, fd) => fs.readSync(fd, ...args) },
    { name: `read callback ${name}`, expected, run: (fs, fd) => new Promise((resolve, reject) => {
      fs.read(fd, ...args, (error: unknown, count: number) => error ? reject(error) : resolve(count));
    }) },
    { name: `FileHandle.read ${name}`, expected, run: async (fs) => {
      const handle = await fs.promises.open("/file", "r");
      return (await handle.read(...args)).bytesRead;
    } },
  ]));
  for (const row of rows) {
    const runtime = fixture([]);
    const fd = 37;
    runtime.fs.closeSync(fd);
    let result: unknown;
    try {
      const pending = row.run(runtime.fs, fd);
      runtime.flush();
      result = await pending;
    } catch (error) {
      result = (error as NodeJS.ErrnoException).code;
    }
    expect(result, row.name).toBe(row.expected);
  }
});

test("callback readv stdin shares the process waiter and scatters one short read", () => {
  const runtime = fixture([-6, Buffer.from("abc")]);
  const first = Buffer.alloc(2, "."), backing = Buffer.alloc(6, ".");
  const buffers = [first, new DataView(backing.buffer, backing.byteOffset + 1, 3)];
  const results: unknown[] = [];
  runtime.fs.readv(0, buffers, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
  runtime.setContext("polling");
  expect(runtime.pending()).toBe(1);
  expect(runtime.pump()).toBe(false);
  expect(results).toEqual([]);
  expect(runtime.wait()).toBe(true);
  expect(runtime.pump()).toBe(true);
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 3, buffers]]);
  expect((results[0] as unknown[])[2]).toBe(buffers);
  expect(first.toString()).toBe("ab");
  expect(backing.toString()).toBe(".c....");
  expect(runtime.contexts).toEqual(["registration"]);
  expect(runtime.reads).toEqual([[0, 5], [0, 5]]);
  expect(runtime.syncReads).toEqual([]);
  expect(runtime.networkReads()).toBe(0);
  expect(runtime.pending()).toBe(0);
});

test("callback readv stdin propagates EOF and EBADF without touching the views", () => {
  for (const result of [0, -8]) {
    const runtime = fixture([result]);
    const buffers = [Buffer.from("keep")], results: unknown[] = [];
    runtime.fs.readv(0, buffers, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
    runtime.pump();
    runtime.flush();
    expect(results).toEqual([[result === 0 ? null : expect.objectContaining({ code: "EBADF" }), 0, buffers]]);
    expect(buffers[0]!.toString()).toBe("keep");
    expect(runtime.reads).toEqual([[0, 4]]);
    expect(runtime.pending()).toBe(0);
  }
});

test("callback readv with positioned stdin or empty views does not register a process waiter", () => {
  const runtime = fixture([]);
  const results: unknown[] = [], empty: Uint8Array[] = [], zero = [Buffer.alloc(0)], bytes = [Buffer.alloc(1)];
  const complete = (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]);
  runtime.fs.readv(0, empty, complete);
  runtime.fs.readv(0, zero, complete);
  runtime.fs.readv(0, bytes, 0, complete);
  expect(runtime.pending()).toBe(0);
  expect(runtime.reads).toEqual([]);
  expect(runtime.syncReads).toEqual([[0, 0, -1], [0, 1, 0]]);
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 0, empty], [null, 0, zero], [null, 1, bytes]]);
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


test("stdin readv bounds 1024 aliases of one 4 MiB view to a 64 KiB request", () => {
  const runtime = fixture([-6, Buffer.from("abcdefgh")]);
  const view = Buffer.alloc(4 * 1024 * 1024, ".");
  const buffers = Array.from({ length: 1024 }, () => view);
  const results: unknown[] = [];
  runtime.fs.readv(0, buffers, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
  runtime.setContext("polling");
  expect(runtime.pump()).toBe(false);
  expect(runtime.pending()).toBe(1);
  expect(runtime.pump()).toBe(true);
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 8, buffers]]);
  expect((results[0] as unknown[])[2]).toBe(buffers);
  expect(view.subarray(0, 10).toString()).toBe("abcdefgh..");
  expect(runtime.reads).toEqual([[0, 65536], [0, 65536]]);
  expect(runtime.contexts).toEqual(["registration"]);
  expect(runtime.pending()).toBe(0);
});

test("stdin readv returns a full first view without another read or waiting for future input", () => {
  const runtime = fixture([Buffer.from("ab"), -6, Buffer.from("later")]);
  const buffers = [Buffer.alloc(2, "."), Buffer.alloc(4, ".")];
  const results: unknown[] = [];
  runtime.fs.readv(0, buffers, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
  expect(runtime.pump()).toBe(true);
  expect(runtime.pending()).toBe(0);
  runtime.flush();
  expect(results).toEqual([[null, 2, buffers]]);
  expect(buffers.map(view => view.toString())).toEqual(["ab", "...."]);
  expect(runtime.reads).toEqual([[0, 6]]);
});

test("regular-file stdin uses the sequential native-file path rather than the pipe waiter", () => {
  const runtime = fixture([], true, true, 0o100000);
  const buffers = [Buffer.alloc(2), Buffer.alloc(2)];
  const results: unknown[] = [];
  runtime.fs.readv(0, buffers, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
  expect(runtime.pending()).toBe(0);
  runtime.flush();
  expect(results).toEqual([[null, 4, buffers]]);
  expect(runtime.reads).toEqual([]);
  expect(runtime.syncReads).toEqual([[0, 2, -1], [0, 2, -1]]);
});
