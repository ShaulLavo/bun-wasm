import { afterAll, afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

type FileApi = Blob & { fd: number | null; stat(): Promise<{ size: number; isFile(): boolean }>; exists(): Promise<boolean> };
type Api = { file(target: string | number): FileApi; write(target: string | number | FileApi, data: string): Promise<number> };
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-file-controls-"));
const owned = new Set<number>();
afterEach(() => { for (const fd of owned) closeSync(fd); owned.clear(); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
function fixture(text = "abcdef") {
  const path = join(scratch, `file-${sequence++}`);
  writeFileSync(path, text);
  return path;
}
function open(path: string, flags = "r") {
  const fd = openSync(path, flags);
  owned.add(fd);
  return fd;
}
function section(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing source section ${start}`);
  return source.slice(from, to);
}
function emitHelper(path: string, output: string) {
  const result = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname, path, output]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
function adapter(Stream = ReadableStream) {
  const reads: { fd: number; length: number; position: number; bytes: number }[] = [];
  const opens: number[] = [], closes: number[] = [], wholeReads: string[] = [];
  const native = {
    cwd: () => scratch,
    utf8Encode: (text: string) => new TextEncoder().encode(text),
    stat: statSync, fstat: fstatSync, exists: existsSync,
    readFile(path: string) { wholeReads.push(path); return readFileSync(path); },
    open(path: string, flags: number) { expect(flags).toBe(0); const fd = open(path); opens.push(fd); return fd; },
    close(fd: number) { closes.push(fd); owned.delete(fd); closeSync(fd); },
    read(fd: number, length: number, position = -1) {
      const bytes = new Uint8Array(Math.trunc(length));
      const count = readSync(fd, bytes, 0, bytes.length, position < 0 ? null : Math.trunc(position));
      reads.push({ fd, length, position, bytes: count });
      return bytes.subarray(0, count);
    },
    write(fd: number, bytes: Uint8Array) { return writeSync(fd, bytes); },
    writeFile(path: string, bytes: Uint8Array) { writeFileSync(path, bytes); return bytes.length; },
  };
  const globals = { Uint8Array, ArrayBuffer, URL, TextDecoder, Response, ReadableStream: Stream, RangeError };
  function requireModule(name: string): unknown {
    if (name === "archive") return { Archive: class Archive {} };
    if (name === "streams") return { ReadableStream: Stream };
    if (name !== "bun_file") throw new Error(`Unexpected require ${name}`);
    const path = new URL("../crates/bunwasm-runtime/src/js/bun_file.ts", import.meta.url);
    const output = join(scratch, "bun_file.js");
    if (!existsSync(output)) emitHelper(path.pathname, output);
    return runInNewContext(readFileSync(output, "utf8"), globals)({ native, require: requireModule });
  }
  const internal = {
    mimeType: () => "", require: requireModule,
    builtin: () => ({ statSync, fstatSync }),
    makeByteStream(bytes: Uint8Array) { return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); },
  };
  const web = readFileSync(new URL("../crates/bunwasm-runtime/src/js/web.js", import.meta.url), "utf8");
  const bun = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bun.js", import.meta.url), "utf8");
  const code = section(web, "  function concatBytes(chunks)", "  const streamWeb =")
    + section(bun, "  function toPath(target)", "  function sleep(ms)") + "\n({ file, write })";
  const api: Api = runInNewContext(code, { ...globals, internal, native });
  return { api, reads, opens, closes, wholeReads };
}

test("numeric Bun.file reads and stat work; sliced text uses positional policy, not native cursor parity", async () => {
  const path = fixture(), fd = open(path);
  readSync(fd, new Uint8Array(2));
  const { api } = adapter(), file = api.file(fd);
  expect(file.size).toBe(6);
  expect((await file.stat()).isFile()).toBe(true);
  expect(await file.exists()).toBe(true);
  expect(await file.slice(1, 3).text()).toBe("bc");
  expect(await file.text()).toBe("cdef");
  expect(await file.text()).toBe("");
  expect(fstatSync(fd).size).toBe(6);
});

test("numeric writes use the caller descriptor, position and lifetime, never a numeric pathname", async () => {
  const path = fixture("original"), fd = open(path, "r+");
  const { api } = adapter();
  expect(await api.write(fd, "new")).toBe(3);
  expect(await api.write(api.file(fd), "!")).toBe(1);
  expect(readFileSync(path, "utf8")).toBe("new!inal");
  expect(existsSync(join(scratch, String(fd)))).toBe(false);
  expect(fstatSync(fd).size).toBe(8);
});

test("small slices read only their exact backing range and close owned descriptors", async () => {
  const path = fixture("a".repeat(2 * 1024 * 1024));
  const { api, reads, wholeReads, opens, closes } = adapter();
  expect(await api.file(path).slice(123, 4219).text()).toBe("a".repeat(4096));
  expect(wholeReads).toEqual([]);
  expect(reads.map(r => [r.length, r.position, r.bytes])).toEqual([[4096, 123, 4096]]);
  expect(opens).toEqual(closes);
});

const rangeCases = [
  { label: "integer control", start: 1, end: 3, text: "bc", position: 1, length: 2 },
  { label: "fractional start", start: 1.5, end: 3, text: "bc", position: 1, length: 2 },
  { label: "NaN start", start: NaN, end: 3, text: "abc", position: 0, length: 3 },
  { label: "fractional end", start: 1, end: 3.5, text: "bc", position: 1, length: 2 },
  { label: "NaN end", start: 1, end: NaN, text: "", position: 1, length: 0 },
];

async function streamText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = "";
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      text += new TextDecoder().decode(result.value);
    }
  } finally { await reader.cancel(); }
  return text;
}

for (const { engine, consumer } of ["host", "polyfill"].flatMap(engine => ["text", "stream"].map(consumer => ({ engine, consumer })))) {
  test.each(rangeCases)(`${engine} ${consumer} normalizes $label before I/O`, async (range) => {
    const path = fixture();
    const { api, reads, wholeReads, opens, closes } = adapter(engine === "host" ? ReadableStream : polyfillStream());
    const file = api.file(path).slice(range.start, range.end);
    const text = consumer === "text" ? await file.text() : await streamText(file.stream());
    expect(text).toBe(range.text);
    const expected = range.length ? [[range.length, range.position, range.length]] : [];
    expect(reads.map(r => [r.length, r.position, r.bytes])).toEqual(expected);
    expect(wholeReads).toEqual([]);
    expect(opens).toEqual(closes);
  });
}

test("stream demand and cancellation never read the remainder or close borrowed descriptors", async () => {
  const path = fixture("x".repeat(2 * 1024 * 1024));
  const { api, reads, wholeReads, opens, closes } = adapter();
  const stream = api.file(path).stream();
  expect(reads).toEqual([]);
  expect(opens).toEqual([]);
  const reader = stream.getReader();
  const first = await reader.read();
  expect(first.value?.length).toBeGreaterThan(0);
  expect(first.value?.length).toBeLessThanOrEqual(256 * 1024);
  await reader.cancel();
  expect(reads).toHaveLength(1);
  expect(wholeReads).toEqual([]);
  expect(opens).toEqual(closes);
  const fd = open(path);
  readSync(fd, new Uint8Array(2));
  const borrowed = api.file(fd).slice(4, 9).stream().getReader();
  expect(new TextDecoder().decode((await borrowed.read()).value)).toBe("xxxxx");
  await borrowed.cancel();
  expect(fstatSync(fd).size).toBe(2 * 1024 * 1024);
  const byte = new Uint8Array(1);
  expect(readSync(fd, byte)).toBe(1);
  expect(reads.at(-1)?.position).toBe(4);
});

test("closed descriptor errors propagate and owned stream failures release resources", async () => {
  const fd = open(fixture());
  closeSync(fd); owned.delete(fd);
  const { api, opens, closes } = adapter();
  await expect(api.file(fd).text()).rejects.toMatchObject({ code: "EBADF" });
  await expect(api.file(fd).stat()).rejects.toMatchObject({ code: "EBADF" });
  await expect(api.write(fd, "x")).rejects.toMatchObject({ code: "EBADF" });
  await expect(api.file(fd).stream().getReader().read()).rejects.toMatchObject({ code: "EBADF" });
  await expect(api.file(scratch).stream().getReader().read()).rejects.toMatchObject({ code: "EISDIR" });
  expect(opens).toEqual(closes);
});

function polyfillStream(): typeof ReadableStream {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/streams_polyfill.js", import.meta.url), "utf8");
  return runInNewContext(source, { Uint8Array, ArrayBuffer, DataView, structuredClone, queueMicrotask })().ReadableStream;
}

for (const engine of ["host", "polyfill"]) {
  test(`${engine} stream keeps exact byte ranges, EOF, repeated reads and borrowed fd positions`, async () => {
    const path = fixture("0123456789".repeat(20_000));
    const fd = open(path);
    readSync(fd, new Uint8Array(3));
    const { api, reads, closes } = adapter(engine === "host" ? ReadableStream : polyfillStream());
    const range = api.file(fd).slice(17, 140_003);
    for (let repeat = 0; repeat < 2; repeat++) {
      const reader = range.stream().getReader();
      let text = "";
      for (let result = await reader.read(); !result.done; result = await reader.read()) {
        text += new TextDecoder().decode(result.value);
      }
      expect(text).toBe(readFileSync(path, "utf8").slice(17, 140_003));
    }
    expect(reads.every(r => r.position >= 17 && r.position + r.length <= 140_003)).toBe(true);
    expect(reads.every(r => r.length <= 64 * 1024)).toBe(true);
    const byte = new Uint8Array(1);
    readSync(fd, byte);
    expect(new TextDecoder().decode(byte)).toBe("3");
    expect(closes).not.toContain(fd);
  });
}

test("empty and past-EOF ranges do not read bytes; cancelling before demand does not open a file", async () => {
  const { api, reads, opens, closes } = adapter();
  const path = fixture();
  expect(await api.file(path).slice(2, 2).text()).toBe("");
  expect(await api.file(path).slice(10, 20).text()).toBe("");
  expect(await api.file(path).slice(4, 20).text()).toBe("ef");
  expect(reads.map(r => [r.position, r.bytes])).toEqual([[4, 2]]);
  expect(opens).toEqual(closes);
  const before = opens.length;
  await api.file(path).stream().cancel();
  expect(opens).toHaveLength(before);
  await expect(api.file(join(scratch, "absent")).stream().getReader().read()).rejects.toMatchObject({ code: "ENOENT" });
});

test("invalid numeric descriptors reject before I/O instead of truncating or becoming paths", () => {
  const { api, reads, opens } = adapter();
  for (const invalid of [-1, 1.5, NaN, Infinity, 2147483648]) {
    expect(() => api.file(invalid)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => api.write(invalid, "")).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  }
  expect(reads).toEqual([]);
  expect(opens).toEqual([]);
});

for (const engine of ["host", "polyfill"]) {
  test(`${engine} BYOB reader completes its EOF request and releases owned descriptors`, async () => {
    const { api, opens, closes } = adapter(engine === "host" ? ReadableStream : polyfillStream());
    const reader = api.file(fixture()).stream().getReader({ mode: "byob" });
    try {
      const first = await reader.read(new Uint8Array(12));
      expect(new TextDecoder().decode(first.value)).toBe("abcdef");
      const eof = await reader.read(new Uint8Array(12));
      expect(eof.done).toBe(true);
      expect(opens).toEqual(closes);
    } finally { await reader.cancel(); }
  }, 1000);
}
