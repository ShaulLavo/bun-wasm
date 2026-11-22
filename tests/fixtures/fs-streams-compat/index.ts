import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = fs.mkdtempSync("bun-wasm-fs-streams-compat-");

try {
  // 1. createReadStream.close(cb) reports premature close error.
  const sample = path.join(root, "sample.txt");
  fs.writeFileSync(sample, "hello world");
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(sample);
    rs.close((err?: Error | null) => {
      try {
        assert.ok(err);
        assert.ok(err.message.includes("Premature close"));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  // 2. WriteStream _destroy waits for in-flight _write before closing fd.
  {
    const events: string[] = [];
    let finishWrite!: () => void;
    let resolveStarted!: () => void;
    const writeStarted = new Promise<void>((r) => { resolveStarted = r; });
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
    const closed = new Promise<void>((r) => stream.on("close", () => { events.push("close-event"); r(); }));
    stream.write(Buffer.from("hello"));
    await writeStarted;
    stream.destroy();
    await new Promise<void>((r) => setImmediate(() => setImmediate(r)));
    finishWrite();
    await closed;
    assert.deepEqual(events, ["write-start", "write-cb", "close", "error:ERR_STREAM_DESTROYED", "close-event"]);
  }

  // 3. WriteStream _destroy waits for in-flight _writev before closing fd.
  {
    const events: string[] = [];
    let finishWritev!: () => void;
    let resolveStarted!: () => void;
    const writevStarted = new Promise<void>((r) => { resolveStarted = r; });
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
    await new Promise<void>((r) => stream.on("ready", r));
    const closed = new Promise<void>((r) => stream.on("close", () => { events.push("close-event"); r(); }));
    stream.cork();
    stream.write(Buffer.from("aa"));
    stream.write(Buffer.from("bb"));
    stream.uncork();
    await writevStarted;
    stream.destroy();
    await new Promise<void>((r) => setImmediate(() => setImmediate(r)));
    finishWritev();
    await closed;
    assert.deepEqual(events, ["writev-start", "writev-cb", "close", "error:ERR_STREAM_DESTROYED", "close-event"]);
  }

  // 4. options.fs without writev falls back to _write and sets _writev = null; short write keeps position undefined.
  {
    const out = path.join(root, "short.bin");
    const writes: Array<{ length: number; position: unknown }> = [];
    const stream = fs.createWriteStream(out, {
      fs: {
        open: fs.open,
        close: fs.close,
        fsync: fs.fsync,
        write(fd: number, buffer: Buffer, offset: number, length: number, position: unknown, cb: any) {
          writes.push({ length, position });
          const take = writes.length === 1 ? 4 : length;
          return fs.write(fd, buffer, offset, take, position as any, cb);
        },
      } as any,
    });
    assert.equal((stream as any)._writev, null);
    const closed = new Promise<void>((r) => stream.on("close", r));
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

  // 5. fs.Utf8Stream keeps its function name and delays 'drain' after reopen while a write is in flight.
  {
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
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.write("before reopen\n");
      stream.once("drain", () => {
        stream.reopen();
        stream.once("ready", () => {
          holdWrites = true;
          stream.write("after reopen\n");
          assert.equal(stream.writing, true);
          let drainedWhileHeld = false;
          const onEarlyDrain = () => { drainedWhileHeld = true; };
          stream.on("drain", onEarlyDrain);
          setImmediate(() => {
            stream.off("drain", onEarlyDrain);
            try {
              assert.equal(drainedWhileHeld, false);
              assert.equal(typeof heldWrite, "function");
            } catch (e) {
              reject(e);
              return;
            }
            stream.once("drain", () => {
              try {
                assert.equal(fs.readFileSync(dest, "utf8"), "before reopen\nafter reopen\n");
              } catch (e) {
                reject(e);
                return;
              }
              stream.once("close", resolve);
              stream.end();
            });
            holdWrites = false;
            heldWrite!();
          });
        });
      });
    });
  }

  console.log("fs-streams-compat ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
