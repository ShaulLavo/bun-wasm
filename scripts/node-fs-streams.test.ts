import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url), "utf8");
const streamSource = fs.readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_stream_core.js", import.meta.url), "utf8");
const fixture = new URL("../tests/fixtures/fs-stream-constructors/contract.ts", import.meta.url).pathname;

test("production fs adapter obeys the same real-descriptor stream contract as Node", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "bun-wasm-fs-streams-"));
  const descriptors = new Set<number>();
  try {
    const factory: unknown = runInNewContext(source, { Uint8Array, ArrayBuffer, DataView, URL });
    assert.equal(typeof factory, "function");
    assert.ok(typeof factory === "function");
    const streamFactory: unknown = runInNewContext(streamSource, { self: { AbortController, AbortSignal }, AbortController, AbortSignal, Uint8Array, Buffer, queueMicrotask, DOMException });
    assert.ok(typeof streamFactory === "function");
    const streams: unknown = streamFactory({ builtin: require, require: () => ({ adapters: {} }) });
    assert.ok(streams && typeof streams === "object" && "Stream" in streams);
    const runtime: unknown = factory({
      native: {
        open(path: string, flags: string) { const fd = fs.openSync(path, flags); descriptors.add(fd); return fd; },
        close(fd: number) { fs.closeSync(fd); descriptors.delete(fd); },
        read(fd: number, length: number, position: number) {
          const bytes = Buffer.alloc(length);
          return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, position < 0 ? null : position));
        },
        write: (fd: number, bytes: Uint8Array, position: number) => fs.writeSync(fd, bytes, 0, Math.min(bytes.length, 2), position < 0 ? null : position),
        readFile: fs.readFileSync,
        writeFile: (path: string, bytes: Uint8Array, append: boolean) => fs.writeFileSync(path, bytes, { flag: append ? "a" : "w" }),
        fstat: fs.fstatSync,
      },
      require(name: string) { return name === "fs_watch" ? () => ({}) : require(name); },
      builtin: (name: string) => name === "node:stream" ? streams.Stream : require(name),
      realTimers: { setImmediate },
      describe: String,
      toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    });
    assert.ok(runtime && typeof runtime === "object" && "fs" in runtime);
    const build = await Bun.build({ entrypoints: [fixture], target: "node", format: "cjs" });
    assert.ok(build.success && build.outputs[0]);
    const module: { exports: unknown } = { exports: {} };
    runInNewContext(await build.outputs[0].text(), { module, exports: module.exports, require, Buffer, setTimeout, clearTimeout });
    const exports = module.exports;
    assert.ok(exports && typeof exports === "object" && "verifyFilesystemStreams" in exports && typeof exports.verifyFilesystemStreams === "function");
    await exports.verifyFilesystemStreams(runtime.fs, root, streams.Stream);
    expect(descriptors.size).toBe(0);
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
