import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url), "utf8");

// Run the production adapter with a counted, short-reading native boundary. All
// state is fixture-owned memory; no process, descriptor, file or timer survives.
function fixture(bytes = "abcdefgh", limit = Infinity, mode: number | null = 0o100000, failAt = Infinity) {
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
      fstat(fd: number) {
        if (mode === null || closed.has(fd)) throw new Error("metadata unavailable");
        return { mode };
      },
      read(fd: number, length: number, position: number) {
        reads.push([fd, length, position]);
        if (reads.length === failAt) throw Object.assign(new Error("read EIO"), { code: "EIO" });
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

test("readvSync stops at the first short view without summing later capacities", () => {
  const runtime = fixture("abcdefgh", 1);
  const backing = Buffer.alloc(12, ".");
  const views = [backing.subarray(1, 3), new DataView(backing.buffer, backing.byteOffset + 5, 4), backing.subarray(10, 10)];
  expect(runtime.fs.readvSync(7, views)).toBe(1);
  expect(backing.toString()).toBe(".a..........");
  expect(runtime.reads).toEqual([[7, 2, -1]]);
  expect(runtime.cursor()).toBe(1);
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
  expect(runtime.reads).toEqual([[7, 2, 3], [7, 2, 5], [7, 1, -1], [7, 4, 99]]);
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
  expect(runtime.reads).toEqual([[7, 3, -1], [7, 2, -1]]);
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

test("callback readv completes later, reports the original array, and stops at a short view", () => {
  const runtime = fixture("abcdefgh", 1);
  const buffers = [Buffer.alloc(2, "."), Buffer.alloc(4, ".")];
  const results: unknown[] = [];
  runtime.fs.readv(7, buffers, (error: unknown, bytesRead: number, returned: unknown) => results.push([error, bytesRead, returned]));
  expect(results).toEqual([]);
  expect(buffers.map(view => view.toString())).toEqual(["a.", "...."]);
  runtime.flush();
  expect(results).toEqual([[null, 1, buffers]]);
  expect((results[0] as unknown[])[2]).toBe(buffers);
  expect(runtime.reads).toEqual([[7, 2, -1]]);
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
  expect(runtime.reads).toEqual([[7, 2, 2], [7, 2, 4]]);
  expect(runtime.cursor()).toBe(0);
  const empty: Uint8Array[] = [];
  const zero = await handle.readv(empty);
  expect(zero.bytesRead).toBe(0);
  expect(zero.buffers).toBe(empty);
  expect(runtime.reads).toEqual([[7, 2, 2], [7, 2, 4]]);
  await handle.close();
  await expect(handle.readv([])).rejects.toMatchObject({ code: "EBADF", syscall: "readv" });
  expect(runtime.reads).toEqual([[7, 2, 2], [7, 2, 4]]);
  expect(runtime.fs.promises.readv).toBeUndefined();
});


test("1024 aliases of a 4 MiB view read eight bytes without a combined-capacity allocation", async () => {
  const runtime = fixture();
  const view = Buffer.alloc(4 * 1024 * 1024, ".");
  const buffers = Array.from({ length: 1024 }, () => view);
  expect(runtime.fs.readvSync(7, buffers, 0)).toBe(8);
  expect(view.subarray(0, 10).toString()).toBe("abcdefgh..");
  const results: unknown[] = [];
  runtime.fs.readv(7, buffers, 0, (error: unknown, count: number, returned: unknown) => results.push([error, count, returned]));
  expect(results).toEqual([]);
  runtime.flush();
  expect(results).toEqual([[null, 8, buffers]]);
  expect((results[0] as unknown[])[2]).toBe(buffers);
  const handle = await runtime.fs.promises.open("/file", "r");
  try {
    const result = await handle.readv(buffers, 0);
    expect(result.bytesRead).toBe(8);
    expect(result.buffers).toBe(buffers);
  } finally { await handle.close(); }
  expect(runtime.reads).toEqual(Array.from({ length: 3 }, () => [7, view.length, 0]));
  expect(runtime.cursor()).toBe(0);
});

for (const mode of [0o010000, 0o020000, 0o140000, null]) {
  test(`non-regular or unclassified descriptor ${mode} reads a single bounded prefix`, () => {
    const runtime = fixture("abcdefgh", Infinity, mode);
    const view = Buffer.alloc(4 * 1024 * 1024, ".");
    const buffers = Array.from({ length: 1024 }, () => view);
    expect(runtime.fs.readvSync(7, buffers)).toBe(8);
    expect(view.subarray(0, 10).toString()).toBe("abcdefgh..");
    expect(runtime.reads).toEqual([[7, 65536, -1]]);
    expect(runtime.cursor()).toBe(8);
  });
}

test("regular-file EOF after a full first view preserves the remaining destination", () => {
  const runtime = fixture("abc");
  const buffers = [Buffer.alloc(2, "."), Buffer.alloc(4, "."), Buffer.alloc(2, ".")];
  expect(runtime.fs.readvSync(7, buffers)).toBe(3);
  expect(buffers.map(view => view.toString())).toEqual(["ab", "c...", ".."]);
  expect(runtime.reads).toEqual([[7, 2, -1], [7, 4, -1]]);
  expect(runtime.cursor()).toBe(3);
});

test("a regular-file error after progress returns committed bytes instead of losing them", () => {
  const runtime = fixture("abcdefgh", Infinity, 0o100000, 2);
  const buffers = [Buffer.alloc(2, "."), Buffer.alloc(4, ".")];
  expect(runtime.fs.readvSync(7, buffers)).toBe(2);
  expect(buffers.map(view => view.toString())).toEqual(["ab", "...."]);
  expect(runtime.reads).toEqual([[7, 2, -1], [7, 4, -1]]);
  expect(runtime.cursor()).toBe(2);
});

for (const firstSize of [2, 4]) {
  test(`readv returns ${firstSize === 2 ? "a full" : "a short"} first view while the actual pipe writer stays open`, async () => {
    const executable = new URL("fixtures/fs-readv-pipe.ts", import.meta.url).pathname;
    const sourcePath = new URL("../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url).pathname;
    for (const api of ["sync", "callback"]) await checkOpenPipe(executable, sourcePath, firstSize, api);
  });
}

async function checkOpenPipe(executable: string, sourcePath: string, firstSize: number, api: string) {
  const child = Bun.spawn([process.execPath, executable, sourcePath, String(firstSize), api], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL",
  });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    child.stdin.write("ab");
    await child.stdin.flush(); // Deliberately do not end the writer before the read returns.
    const [status, output, errors] = await Promise.all([child.exited, stdout, stderr]);
    expect(errors).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual({ count: 2, buffers: ["ab".padEnd(firstSize, "."), "...."], reads: [[firstSize + 4, -1]] });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await child.stdin.end();
    await Promise.all([stdout, stderr]);
  }
}
