import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url), "utf8");

// Run the production adapter with a counted, short-reading native boundary. All
// state is fixture-owned memory; no process, descriptor, file or timer survives.
function fixture(bytes = "abcdefgh", limit = Infinity) {
  const reads: [number, number, number][] = [];
  const immediate: (() => void)[] = [];
  const closed = new Set<number>();
  let cursor = 0;
  const factory = runInNewContext(source, { Uint8Array, ArrayBuffer, DataView, URL });
  const { fs } = factory({
    native: {
      hostCaps: { proc_spawn: false },
      open: () => 7,
      close: (fd: number) => closed.add(fd),
      read(fd: number, length: number, position: number) {
        reads.push([fd, length, position]);
        if (closed.has(fd)) throw Object.assign(new Error("read EBADF"), { code: "EBADF" });
        const start = position < 0 ? cursor : position;
        const chunk = Buffer.from(bytes).subarray(start, start + Math.min(length, limit));
        if (position < 0) cursor += chunk.length;
        return chunk;
      },
    },
    require(name: string) {
      if (name === "buffer") return { Buffer };
      if (name === "fs_watch") return () => ({});
      throw new Error(`Unexpected readv dependency ${name}`);
    },
    realTimers: { setImmediate: (fn: () => void) => immediate.push(fn) },
    describe: String,
    toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  });
  return { fs, reads, cursor: () => cursor, flush() { while (immediate.length) immediate.shift()!(); } };
}

test("readvSync makes one native read and scatters a short result into mixed offset views", () => {
  const runtime = fixture("abcdefgh", 3);
  const backing = Buffer.alloc(12, ".");
  const views = [backing.subarray(1, 3), new DataView(backing.buffer, backing.byteOffset + 5, 4), backing.subarray(10, 10)];
  expect(runtime.fs.readvSync(7, views)).toBe(3);
  expect(backing.toString()).toBe(".ab..c......");
  expect(runtime.reads).toEqual([[7, 6, -1]]);
  expect(runtime.cursor()).toBe(3);
});

test("positioned readvSync leaves the shared cursor unchanged, and EOF leaves views untouched", () => {
  const runtime = fixture();
  const first = Buffer.alloc(2), second = Buffer.alloc(2);
  expect(runtime.fs.readvSync(7, [first, second], 3)).toBe(4);
  expect(Buffer.concat([first, second]).toString()).toBe("defg");
  expect(runtime.cursor()).toBe(0);
  const next = Buffer.alloc(1);
  expect(runtime.fs.readvSync(7, [next])).toBe(1);
  expect(next.toString()).toBe("a");
  const unchanged = Buffer.from("keep");
  expect(runtime.fs.readvSync(7, [unchanged], 99)).toBe(0);
  expect(unchanged.toString()).toBe("keep");
  expect(runtime.reads).toEqual([[7, 4, 3], [7, 1, -1], [7, 4, 99]]);
});

test("readv caps a native operation at 1024 views but validates every supplied view", () => {
  const runtime = fixture();
  const accepted = Buffer.alloc(1), ignored = Buffer.from(".");
  expect(runtime.fs.readvSync(7, Array.from({ length: 1023 }, () => Buffer.alloc(0)).concat([accepted]))).toBe(1);
  const full: unknown[] = Array.from({ length: 1024 }, () => Buffer.alloc(0));
  expect(runtime.fs.readvSync(7, full.concat([ignored]))).toBe(0);
  expect(accepted.toString()).toBe("a");
  expect(ignored.toString()).toBe(".");
  expect(() => runtime.fs.readvSync(7, full.concat([{}]))).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(runtime.reads).toEqual([[7, 1, -1], [7, 0, -1]]);
});

test("overlapping readv destinations are filled in vector order", () => {
  const runtime = fixture("abcde");
  const bytes = Buffer.alloc(4, ".");
  expect(runtime.fs.readvSync(7, [bytes.subarray(0, 3), bytes.subarray(1, 3)])).toBe(5);
  expect(bytes.toString()).toBe("ade.");
  expect(runtime.reads).toEqual([[7, 5, -1]]);
});

test("Bun empty-vector semantics skip the syscall but validate the descriptor argument", () => {
  const runtime = fixture();
  runtime.fs.closeSync(7);
  expect(runtime.fs.readvSync(7, [], "ignored")).toBe(0);
  expect(() => runtime.fs.readvSync(-1, [])).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  expect(() => runtime.fs.readvSync("7", [])).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(() => runtime.fs.readv(-1, [], () => {})).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  expect(() => runtime.fs.readv("7", [], () => {})).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(runtime.reads).toEqual([]);
  expect(() => runtime.fs.readvSync(7, [Buffer.alloc(0)])).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(() => runtime.fs.readvSync(7, [Buffer.alloc(0), new DataView(new ArrayBuffer(0))])).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(runtime.reads).toEqual([[7, 0, -1], [7, 0, -1]]);
});

test("readv validates all views before a syscall, with Bun fd-first argument precedence", () => {
  const runtime = fixture();
  for (const invalid of [null, {}, ["text"], [new ArrayBuffer(0)], [Buffer.alloc(1), {}], new Array(1)]) {
    expect(() => runtime.fs.readvSync(7, invalid)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => runtime.fs.readvSync(-1, invalid)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => runtime.fs.readv(7, invalid, () => {})).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  }
  expect(() => runtime.fs.readv(7, [], null)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(runtime.reads).toEqual([]);
});

for (const position of [null, undefined, -1, -2, 0.5, NaN, Infinity, "1", 1n, true, {}, 2 ** 53]) {
  test(`Bun readv position ${String(position)} selects the current cursor`, () => {
    const runtime = fixture();
    const target = Buffer.alloc(1);
    expect(runtime.fs.readvSync(7, [target], position)).toBe(1);
    expect(target.toString()).toBe("a");
    expect(runtime.cursor()).toBe(1);
    expect(runtime.reads).toEqual([[7, 1, -1]]);
  });
}

test("callback readv completes later, reports the original array, and performs one short read", () => {
  const runtime = fixture("abcdefgh", 3);
  const buffers = [Buffer.alloc(2, "."), Buffer.alloc(4, ".")];
  const results: unknown[] = [];
  runtime.fs.readv(7, buffers, (error: unknown, bytesRead: number, returned: unknown) => results.push([error, bytesRead, returned]));
  expect(results).toEqual([]);
  expect(buffers.map(view => view.toString())).toEqual(["ab", "c..."]);
  runtime.flush();
  expect(results).toEqual([[null, 3, buffers]]);
  expect((results[0] as unknown[])[2]).toBe(buffers);
  expect(runtime.reads).toEqual([[7, 6, -1]]);
});

test("callback readv delivers fd errors later and keeps input buffers unchanged", () => {
  const runtime = fixture();
  runtime.fs.closeSync(7);
  const buffers = [Buffer.from("keep")];
  const results: unknown[] = [];
  runtime.fs.readv(7, buffers, 3, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
  expect(results).toEqual([]);
  expect(buffers[0]!.toString()).toBe("keep");
  runtime.flush();
  expect(results).toEqual([[expect.objectContaining({ code: "EBADF" }), 0, buffers]]);
  expect(runtime.reads).toEqual([[7, 4, 3]]);
});

test("callback readv skips [] but not a nonempty vector of empty views", () => {
  const runtime = fixture();
  runtime.fs.closeSync(7);
  const results: unknown[] = [];
  const complete = (error: unknown, count: number, buffers: unknown) => results.push([error, count, buffers]);
  const empty: Uint8Array[] = [], one = [Buffer.alloc(0)];
  runtime.fs.readv(7, empty, complete);
  runtime.fs.readv(7, one, complete);
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 0, empty], [expect.objectContaining({ code: "EBADF" }), 0, one]]);
  expect(runtime.reads).toEqual([[7, 0, -1]]);
});

test("FileHandle.readv preserves result identity and rejects closed handles even with []", async () => {
  const runtime = fixture();
  const handle = await runtime.fs.promises.open("/file", "r");
  const first = Buffer.alloc(2);
  const buffers = [first, new DataView(new ArrayBuffer(2))];
  const result = await handle.readv(buffers, 2);
  expect(result.bytesRead).toBe(4);
  expect(result.buffers).toBe(buffers);
  expect(first.toString()).toBe("cd");
  expect(runtime.reads).toEqual([[7, 4, 2]]);
  expect(runtime.cursor()).toBe(0);
  const empty: Uint8Array[] = [];
  const zero = await handle.readv(empty);
  expect(zero.bytesRead).toBe(0);
  expect(zero.buffers).toBe(empty);
  expect(runtime.reads).toEqual([[7, 4, 2]]);
  await handle.close();
  await expect(handle.readv([])).rejects.toMatchObject({ code: "EBADF", syscall: "readv" });
  expect(runtime.reads).toEqual([[7, 4, 2]]);
  expect(runtime.fs.promises.readv).toBeUndefined();
});
