import { Buffer } from "node:buffer";
import { fstatSync, readFileSync, readSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Owned by node-fs-readv.test.ts: the parent keeps the pipe's writer open until
// this process exits, and kills/reaps this process on every failure or deadline.
const factory = runInNewContext(readFileSync(process.argv[2]!, "utf8"), { Uint8Array, ArrayBuffer, DataView, URL });
const reads: [number, number][] = [];
const { fs } = factory({
  native: {
    hostCaps: { proc_spawn: false },
    fstat: fstatSync,
    read(fd: number, length: number, position: number) {
      reads.push([length, position]);
      const bytes = Buffer.alloc(length);
      const count = readSync(fd, bytes, 0, length, position < 0 ? null : position);
      return bytes.subarray(0, count);
    },
  },
  require(name: string) {
    if (name === "buffer") return { Buffer };
    if (name === "fs_watch") return () => ({});
    throw new Error(`Unexpected pipe-fixture module ${name}`);
  },
  realTimers: { setImmediate },
  describe: String,
  toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
});
const buffers = [Buffer.alloc(Number(process.argv[3]), "."), Buffer.alloc(4, ".")];
if (process.argv[4] === "callback") {
  let returned = false;
  fs.readv(0, buffers, (error: Error | null, count: number, original: unknown) => {
    if (error) throw error;
    if (!returned || original !== buffers) throw new Error("Callback timing or identity changed");
    console.log(JSON.stringify({ count, buffers: buffers.map(view => view.toString()), reads }));
  });
  returned = true;
} else {
  const count = fs.readvSync(0, buffers);
  console.log(JSON.stringify({ count, buffers: buffers.map(view => view.toString()), reads }));
}
