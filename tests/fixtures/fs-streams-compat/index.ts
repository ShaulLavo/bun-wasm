import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function waitEvent<T = void>(emitter: { once(event: string, listener: (value: T) => void): unknown }, event: string) {
  return new Promise<T>((resolve) => {
    emitter.once(event, resolve);
  });
}

function nextImmediate() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function testReadStreamPrematureClose(root: string) {
  const sample = path.join(root, "sample.txt");
  fs.writeFileSync(sample, "hello world");
  const error = await new Promise<Error | null | undefined>((resolve) => {
    const rs = fs.createReadStream(sample);
    rs.close((err?: Error | null) => resolve(err));
  });
  assert.ok(error);
  assert.ok(error.message.includes("Premature close"));
}

async function testWriteStreamDestroyWaitsForWrite(root: string) {
  const events: string[] = [];
  let finishWrite!: () => void;
  let resolveStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const stream = fs.createWriteStream(path.join(root, "w1.txt"), {
    fs: {
      open: fs.open,
      write(_fd: number, buf: Buffer, _off: number, len: number, _pos: number, cb: Function) {
        events.push("write-start");
        resolveStarted();
        finishWrite = () => {
          events.push("write-cb");
          cb(null, len, buf);
        };
      },
      close(fd: number, cb: Function) {
        events.push("close");
        fs.close(fd, cb as any);
      },
    } as any,
  });
  stream.on("error", (e: any) => events.push("error:" + e.code));
  const closed = waitEvent(stream, "close").then(() => { events.push("close-event"); });
  stream.write(Buffer.from("hello"));
  await writeStarted;
  stream.destroy();
  await nextImmediate();
  await nextImmediate();
  finishWrite();
  await closed;
  assert.deepEqual(events, ["write-start", "write-cb", "close", "error:ERR_STREAM_DESTROYED", "close-event"]);
}

async function testWriteStreamDestroyWaitsForWritev(root: string) {
  const events: string[] = [];
  let finishWritev!: () => void;
  let resolveStarted!: () => void;
  const writevStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const stream = fs.createWriteStream(path.join(root, "w2.txt"), {
    fs: {
      open: fs.open,
      write: fs.write,
      writev(_fd: number, buffers: Buffer[], _pos: number, cb: Function) {
        events.push("writev-start");
        resolveStarted();
        let total = 0;
        for (const b of buffers) total += b.length;
        finishWritev = () => {
          events.push("writev-cb");
          cb(null, total, buffers);
        };
      },
      close(fd: number, cb: Function) {
        events.push("close");
        fs.close(fd, cb as any);
      },
    } as any,
  });
  stream.on("error", (e: any) => events.push("error:" + e.code));
  await waitEvent(stream, "ready");
  const closed = waitEvent(stream, "close").then(() => { events.push("close-event"); });
  stream.cork();
  stream.write(Buffer.from("aa"));
  stream.write(Buffer.from("bb"));
  stream.uncork();
  await writevStarted;
  stream.destroy();
  await nextImmediate();
  await nextImmediate();
  finishWritev();
  await closed;
  assert.deepEqual(events, ["writev-start", "writev-cb", "close", "error:ERR_STREAM_DESTROYED", "close-event"]);
}

async function testWriteStreamScalarFallbackAndShortWrite(root: string) {
  const out = path.join(root, "short.bin");
  const writes: Array<{ length: number; position: unknown }> = [];
  const stream = fs.createWriteStream(out, {
    fs: {
      open: fs.open,
      close: fs.close,
      fsync: fs.fsync,
      writev: null,
      write(fd: number, buffer: Buffer, offset: number, length: number, position: unknown, cb: any) {
        writes.push({ length, position });
        const take = writes.length === 1 ? 4 : length;
        return fs.write(fd, buffer, offset, take, position as any, cb);
      },
    } as any,
  });
  assert.equal((stream as any)._writev, null);
  const closed = waitEvent(stream, "close");
  stream.cork();
  stream.write(Buffer.from("AAAABBBB"));
  stream.write(Buffer.from("CCCCDDDD"));
  stream.uncork();
  stream.end();
  await closed;
  assert.equal(stream.bytesWritten, 16);
  assert.equal(fs.readFileSync(out, "utf8"), "AAAABBBBCCCCDDDD");
  assert.deepEqual(writes, [
    { length: 8, position: undefined },
    { length: 4, position: undefined },
    { length: 8, position: undefined },
  ]);
}

async function testWriteStreamCustomWritevOnlyAndPositionedShortWrite(root: string) {
  const out = path.join(root, "writev-pos.bin");
  fs.writeFileSync(out, "0123456789");
  const calls: Array<{ lengths: number[]; position: unknown }> = [];
  const stream = fs.createWriteStream(out, {
    flags: "r+",
    start: 2,
    fs: {
      open: fs.open,
      close: fs.close,
      write: null,
      writev(fd: number, buffers: Buffer[], position: unknown, cb: any) {
        calls.push({ lengths: buffers.map((b) => b.length), position });
        if (calls.length === 1) {
          const first = Buffer.concat(buffers).subarray(0, 2);
          return fs.writev(fd, [first], position as any, (err, written) => cb(err, written, buffers));
        }
        return fs.writev(fd, buffers, position as any, cb);
      },
    } as any,
  });
  assert.equal((stream as any)._write, null);
  assert.equal(typeof (stream as any)._writev, "function");
  const closed = waitEvent(stream, "close");
  stream.cork();
  stream.write(Buffer.from("aaa"));
  stream.write(Buffer.from("bbb"));
  stream.uncork();
  stream.end();
  await closed;
  assert.equal(stream.bytesWritten, 6);
  assert.equal(fs.readFileSync(out, "utf8"), "01aaabbb89");
  assert.deepEqual(calls, [
    { lengths: [3, 3], position: 2 },
    { lengths: [4], position: 4 },
  ]);
}

async function testRejectedFileHandleOptionsLeaveHandleOpen(root: string) {
  const target = path.join(root, "handle-ok.txt");
  const handle = await fs.promises.open(target, "w+");
  assert.throws(
    () => fs.createWriteStream(target, { fd: handle, fs: { write: fs.write, close: fs.close } as any }),
    { code: "ERR_METHOD_NOT_IMPLEMENTED" },
  );
  await handle.writeFile("still open");
  await handle.close();
  assert.equal(fs.readFileSync(target, "utf8"), "still open");
}

async function testDefaultFlushWriteStream(root: string) {
  const out = path.join(root, "flushed.txt");
  const stream = fs.createWriteStream(out, { flush: true });
  const closed = waitEvent(stream, "close");
  stream.end("durable");
  await closed;
  assert.equal(fs.readFileSync(out, "utf8"), "durable");
}

async function testUtf8StreamReopenDelaysDrain(root: string) {
  const Utf8Stream = (fs as any).Utf8Stream;
  assert.equal(typeof Utf8Stream, "function");
  assert.equal(Utf8Stream.name, "Utf8Stream");
  const dest = path.join(root, "utf8.log");
  let heldWrite: (() => void) | undefined;
  let holdWrites = false;
  const stream = new Utf8Stream({
    dest,
    sync: false,
    fs: {
      write(...args: any[]) {
        if (!holdWrites) return (fs.write as any)(...args);
        const cb = args.pop();
        heldWrite = () => (fs.write as any)(...args, cb);
      },
    },
  });
  let streamError: unknown;
  stream.on("error", (error: unknown) => { streamError = error; });
  stream.write("before reopen\n");
  await waitEvent(stream, "drain");
  stream.reopen();
  await waitEvent(stream, "ready");
  holdWrites = true;
  stream.write("after reopen\n");
  assert.equal(stream.writing, true);
  let drainedWhileHeld = false;
  const onEarlyDrain = () => { drainedWhileHeld = true; };
  stream.on("drain", onEarlyDrain);
  await nextImmediate();
  stream.off("drain", onEarlyDrain);
  assert.equal(drainedWhileHeld, false);
  assert.equal(typeof heldWrite, "function");
  const drained = waitEvent(stream, "drain");
  holdWrites = false;
  heldWrite!();
  await drained;
  assert.equal(fs.readFileSync(dest, "utf8"), "before reopen\nafter reopen\n");
  const closed = waitEvent(stream, "close");
  stream.end();
  await closed;
  assert.equal(streamError, undefined);
}

const root = fs.mkdtempSync("bun-wasm-fs-streams-compat-");
try {
  await testReadStreamPrematureClose(root);
  await testWriteStreamDestroyWaitsForWrite(root);
  await testWriteStreamDestroyWaitsForWritev(root);
  await testWriteStreamScalarFallbackAndShortWrite(root);
  await testWriteStreamCustomWritevOnlyAndPositionedShortWrite(root);
  await testRejectedFileHandleOptionsLeaveHandleOpen(root);
  await testDefaultFlushWriteStream(root);
  await testUtf8StreamReopenDelaysDrain(root);
  console.log("fs-streams-compat ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
