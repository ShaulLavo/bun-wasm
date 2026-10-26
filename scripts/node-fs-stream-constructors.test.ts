import assert from "node:assert/strict";
import { once } from "node:events";
import { test, expect } from "bun:test";
import * as hostFs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inherits } from "node:util";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const runtimeSource = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const fsSource = hostFs.readFileSync(new URL("node_fs.js", runtimeSource), "utf8");
const streamSource = hostFs.readFileSync(new URL("node_stream_core.js", runtimeSource), "utf8");
const optionsSource = hostFs.readFileSync(new URL("fs_options.ts", runtimeSource), "utf8");
type Filesystem = typeof import("node:fs");
type Streams = typeof import("node:stream");

function productionFilesystem(root: string) {
  const descriptors = new Set<number>();
  const context = {
    self: { AbortController, AbortSignal }, AbortController, AbortSignal,
    Uint8Array, ArrayBuffer, DataView, URL, Buffer, queueMicrotask, DOMException,
  };
  const streamFactory: unknown = runInNewContext(streamSource, context);
  assert.ok(typeof streamFactory === "function");
  const core: unknown = streamFactory({ builtin: require, require: () => ({ adapters: {} }) });
  assert.ok(core && typeof core === "object" && "Stream" in core);
  const optionsFactory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${optionsSource}`));
  const factory: unknown = runInNewContext(fsSource, context);
  assert.ok(typeof factory === "function");
  const runtime: unknown = factory({
    native: {
      hostCaps: { proc_spawn: false },
      open(path: string, flags: string | number) {
        const fd = hostFs.openSync(path, flags);
        descriptors.add(fd);
        return fd;
      },
      close(fd: number) { hostFs.closeSync(fd); descriptors.delete(fd); },
      read(fd: number, length: number, position: number) {
        const bytes = Buffer.alloc(length);
        return bytes.subarray(0, hostFs.readSync(fd, bytes, 0, length, position < 0 ? null : position));
      },
      write: (fd: number, bytes: Uint8Array, position: number) => hostFs.writeSync(fd, bytes, 0, Math.min(bytes.length, 2), position < 0 ? null : position),
      readFile: hostFs.readFileSync,
      fstat: hostFs.fstatSync,
    },
    require(name: string): unknown {
      if (name === "fs_watch") return () => ({});
      if (name === "fs_options") return optionsFactory({});
      return require(name);
    },
    builtin: (name: string) => name === "node:stream" ? core.Stream : require(name),
    realTimers: { setImmediate },
    describe: String,
    toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  });
  assert.ok(runtime && typeof runtime === "object" && "fs" in runtime);
  const fs = runtime.fs as Filesystem;
  const streams = core.Stream as Streams;
  return {
    fs, streams,
    cleanup() {
      for (const fd of descriptors) hostFs.closeSync(fd);
      hostFs.rmSync(root, { recursive: true, force: true });
      expect(descriptors.size).toBe(0);
    },
  };
}

function descriptor(stream: object) {
  assert.ok("fd" in stream);
  return stream.fd;
}

async function closed(stream: import("node:stream").Readable | import("node:stream").Writable) {
  await new Promise<void>(resolve => { stream.once("close", resolve); });
}

function isReadStream(stream: object | undefined, constructor: Filesystem["ReadStream"]) {
  return stream instanceof constructor;
}

test("destroy can test an absent response stream against fs constructors", () => {
  const root = hostFs.mkdtempSync(join(tmpdir(), "bun-wasm-fsstream-destroy-"));
  const runtime = productionFilesystem(root);
  try {
    expect(isReadStream(undefined, runtime.fs.ReadStream)).toBe(false);
  } finally { runtime.cleanup(); }
});

test("production fs streams preserve the Node constructor and descriptor contract", async () => {
  const root = hostFs.mkdtempSync(join(tmpdir(), "bun-wasm-fsstream-contract-"));
  const runtime = productionFilesystem(root);
  try {
    await verifyFilesystemStreams(runtime.fs, root, runtime.streams);
    expect(isReadStream(undefined, runtime.fs.ReadStream)).toBe(false);
  } finally { runtime.cleanup(); }
});

async function verifyFilesystemStreams(fs: Filesystem, root: string, streams: Streams) {
  assert.equal(typeof fs.ReadStream, "function");
  assert.equal(typeof fs.WriteStream, "function");
  assert.equal(Reflect.get(fs, "FileReadStream"), fs.ReadStream);
  assert.equal(Reflect.get(fs, "FileWriteStream"), fs.WriteStream);
  assert.ok(fs.ReadStream.prototype instanceof streams.Readable);
  assert.ok(fs.WriteStream.prototype instanceof streams.Writable);

  const path = join(root, "stream.txt");
  const output = fs.createWriteStream(path, { highWaterMark: 2 });
  const outputClosed = closed(output);
  let writeFd: number | undefined;
  output.once("open", fd => { writeFd = fd; });
  const order: string[] = [];
  output.on("finish", () => order.push("finish"));
  output.on("close", () => order.push("close"));
  assert.ok(output instanceof fs.WriteStream);
  assert.equal(output.write(Buffer.from("abcd")), false);
  output.end("é");
  await outputClosed;
  assert.equal(fs.readFileSync(path, "utf8"), "abcdé");
  assert.equal(output.bytesWritten, 6);
  assert.deepEqual(order, ["finish", "close"]);
  assert.equal(output.destroyed, true);
  assert.equal(descriptor(output), null);
  assert.equal(typeof writeFd, "number");
  assert.ok(typeof writeFd === "number");
  const savedWriteFd = writeFd;
  assert.throws(() => fs.fstatSync(savedWriteFd), { code: "EBADF" });

  const input = fs.createReadStream(path, { highWaterMark: 2, start: 1, end: 4 });
  const inputClosed = closed(input);
  const chunks: Buffer[] = [];
  input.on("data", chunk => { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); });
  await inputClosed;
  assert.ok(input instanceof fs.ReadStream);
  assert.equal(Buffer.concat(chunks).toString("hex"), Buffer.from("bcdé").subarray(0, 4).toString("hex"));
  assert.ok(chunks.length > 1);
  assert.equal(input.bytesRead, 4);
  assert.equal(descriptor(input), null);

  const encoded = fs.createReadStream(path, { highWaterMark: 1, encoding: "utf8" });
  let text = "";
  for await (const chunk of encoded) text += chunk;
  assert.equal(text, "abcdé");
  assert.equal(encoded.destroyed, true);

  const ranged = fs.createReadStream(path, { end: Infinity });
  const rangeClosed = closed(ranged);
  ranged.resume();
  await rangeClosed;
  const hexPath = join(root, "hex.txt");
  const hex = fs.createWriteStream(hexPath, { encoding: "hex" });
  const hexClosed = closed(hex);
  hex.end("c3a9");
  await hexClosed;
  assert.equal(fs.readFileSync(hexPath, "utf8"), "é");
  await inheritedStreams(fs, path, root);
  await errorAndDestroy(fs, path, root);
}

async function inheritedStreams(fs: Filesystem, path: string, root: string) {
  function WrappedRead(this: import("node:fs").ReadStream, file: string, options: object) {
    Reflect.apply(fs.ReadStream, this, [file, options]);
  }
  function WrappedWrite(this: import("node:fs").WriteStream, file: string) {
    Reflect.apply(fs.WriteStream, this, [file]);
  }
  inherits(WrappedRead, fs.ReadStream);
  inherits(WrappedWrite, fs.WriteStream);
  const input: unknown = Reflect.construct(WrappedRead, [path, { highWaterMark: 2 }]);
  const target = join(root, "piped.txt");
  const output: unknown = Reflect.construct(WrappedWrite, [target]);
  assert.ok(input instanceof fs.ReadStream && input instanceof WrappedRead);
  assert.ok(output instanceof fs.WriteStream && output instanceof WrappedWrite);
  const done = closed(output);
  input.pipe(output);
  await done;
  assert.equal(fs.readFileSync(target, "utf8"), "abcdé");
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
}

async function errorAndDestroy(fs: Filesystem, path: string, root: string) {
  const missing = join(root, "missing", "file");
  for (const method of [fs.createReadStream, fs.createWriteStream]) {
    const stream = method(missing);
    const done = closed(stream);
    const errors: unknown[] = [];
    stream.on("error", error => errors.push(error));
    await done;
    assert.equal(errors.length, 1);
    assert.ok(errors[0] && typeof errors[0] === "object" && "code" in errors[0]);
    assert.equal(errors[0].code, "ENOENT");
    assert.equal(stream.destroyed, true);
    assert.equal(descriptor(stream), null);
  }
  const denied = fs.createWriteStream(path, { flags: "r" });
  const deniedClosed = closed(denied);
  const deniedErrors: unknown[] = [];
  denied.on("error", error => deniedErrors.push(error));
  denied.end("forbidden");
  await deniedClosed;
  assert.equal(deniedErrors.length, 1);
  assert.ok(deniedErrors[0] && typeof deniedErrors[0] === "object" && "code" in deniedErrors[0]);
  assert.equal(deniedErrors[0].code, "EBADF");
  assert.equal(descriptor(denied), null);
  const input = fs.createReadStream(path, { highWaterMark: 1 });
  const done = closed(input);
  input.once("data", () => input.destroy());
  input.resume();
  await done;
  assert.equal(input.destroyed, true);
  assert.equal(descriptor(input), null);
  const premature = fs.createWriteStream(join(root, "destroyed.txt"));
  const prematureClosed = closed(premature);
  premature.destroy();
  await prematureClosed;
  assert.equal(descriptor(premature), null);
  assert.equal(premature.destroyed, true);
  const reader = fs.createReadStream(path);
  const readerClosed = closed(reader);
  reader.close();
  await readerClosed;
  assert.equal(descriptor(reader), null);
  assert.throws(() => fs.createReadStream(path, { start: 4, end: 2 }), { code: "ERR_OUT_OF_RANGE" });
  const append = fs.createWriteStream(path, { flags: "a" });
  const appended = once(append, "close");
  append.end("!");
  await appended;
  assert.equal(fs.readFileSync(path, "utf8"), "abcdé!");
}
