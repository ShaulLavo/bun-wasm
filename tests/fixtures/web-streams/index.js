import assert from "node:assert/strict";
import * as web from "node:stream/web";
import { Readable, Writable } from "node:stream";

const names = ["ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableByteStreamController", "ReadableStreamDefaultController", "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "TransformStream", "TransformStreamDefaultController", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream", "ByteLengthQueuingStrategy", "CountQueuingStrategy"];
for (const name of names) assert.equal(web[name], globalThis[name], name);
new TextEncoderStream();
console.log("globals");

const text = new Response(ReadableStream.from(["hello ", "world"]).pipeThrough(new TextEncoderStream()).pipeThrough(new TextDecoderStream()));
assert.equal(await text.text(), "hello world");
console.log("encode/decode");

const [left, right] = ReadableStream.from([1, 2, 3]).tee();
assert.deepEqual(await Array.fromAsync(left), [1, 2, 3]);
const output = [];
await right.pipeThrough(new TransformStream({ transform(x, c) { c.enqueue(x * 2); } })).pipeTo(new WritableStream({ write(x) { output.push(x); } }));
assert.deepEqual(output, [2, 4, 6]);
console.log("tee/pipe/iterate");

const byob = new ReadableStream({ type: "bytes", pull(c) { c.byobRequest.view[0] = 42; c.byobRequest.respond(1); c.close(); } }).getReader({ mode: "byob" });
const buffer = new Uint8Array(8);
assert.equal((await byob.read(buffer)).value[0], 42);
assert.equal(buffer.byteLength, 0);
assert.equal((await byob.read(new Uint8Array(1))).done, true);
byob.releaseLock();
console.log("byob");

let cancelReason;
const source = new ReadableStream({ cancel(reason) { cancelReason = reason; } });
const abort = new AbortController();
const piping = source.pipeTo(new WritableStream(), { signal: abort.signal });
abort.abort("stop");
await assert.rejects(piping, reason => reason === "stop");
assert.equal(cancelReason, "stop");
assert.equal(source.locked, false);
console.log("abort");

for (const format of ["gzip", "deflate", "deflate-raw"]) {
  const encoded = new Blob(["hello ", "world"]);
  const compressed = await new Response(encoded.stream().pipeThrough(new CompressionStream(format))).bytes();
  const restored = new Response(ReadableStream.from(Array.from(compressed, b => new Uint8Array([b]))).pipeThrough(new DecompressionStream(format)));
  assert.equal(await restored.text(), "hello world");
  await assert.rejects(new Response(ReadableStream.from([compressed.subarray(0, compressed.length - 1)]).pipeThrough(new DecompressionStream(format))).text());
  await assert.rejects(new Response(ReadableStream.from([compressed, new Uint8Array([0])]).pipeThrough(new DecompressionStream(format))).text());
}
console.log("compression");

const native = Readable.from([Buffer.from("abc"), Buffer.from("def")]);
assert.equal(await new Response(Readable.toWeb(native)).text(), "abcdef");
const node = Readable.fromWeb(ReadableStream.from([new Uint8Array([65]), new Uint8Array([66])]));
let result = "";
for await (const chunk of node) result += chunk.toString();
assert.equal(result, "AB");
const writes = [];
const sink = new Writable({ write(chunk, encoding, cb) { writes.push(chunk.toString()); cb(); } });
await ReadableStream.from(["a", "b"]).pipeTo(Writable.toWeb(sink));
assert.deepEqual(writes, ["a", "b"]);
console.log("node interop");

const surrogate = new Response(ReadableStream.from(["\ud83d", "\ude00", "\ud800"]).pipeThrough(new TextEncoderStream()));
assert.equal(await surrogate.text(), "😀�");
const bom = new Uint8Array([239, 187, 191, 65, 239, 187, 191, 66]);
const split = ReadableStream.from(Array.from(bom, byte => new Uint8Array([byte])));
assert.equal(await new Response(split.pipeThrough(new TextDecoderStream())).text(), "A\ufeffB");
assert.equal(await new Response(ReadableStream.from([new Uint8Array([0x80])]).pipeThrough(new TextDecoderStream("windows-1252"))).text(), "€");
await assert.rejects(new Response(ReadableStream.from([new Uint8Array([0xc3])]).pipeThrough(new TextDecoderStream("utf-8", { fatal: true }))).text(), TypeError);
console.log("encoding boundaries");

const response = new Response(ReadableStream.from([new Uint8Array([65, 66])]));
const cloned = response.clone();
assert.equal(await response.text(), "AB");
assert.equal(await cloned.text(), "AB");
const request = new Request("http://localhost/", { method: "POST", body: ReadableStream.from([new Uint8Array([67])]) });
assert.equal(await request.text(), "C");
console.log("body interop");

let cancellation;
const nodeCancel = Readable.fromWeb(new ReadableStream({ cancel(reason) { cancellation = reason; } }));
const reason = new Error("cancelled");
nodeCancel.on("error", () => {});
nodeCancel.destroy(reason);
await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(cancellation, reason);
console.log("node cancellation");

const received = [];
const webSink = new WritableStream({ write(chunk) { received.push(new TextDecoder().decode(chunk)); } });
const nodeSink = Writable.fromWeb(webSink);
await new Promise((resolve, reject) => { nodeSink.on("error", reject); nodeSink.end("encoded", resolve); });
assert.deepEqual(received, ["encoded"]);
console.log("writable fromWeb");

const blocked = new TransformStream();
const writer = blocked.writable.getWriter();
let settled = false;
const writing = writer.write(7).then(() => { settled = true; });
await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(settled, false);
const blockedReader = blocked.readable.getReader();
assert.equal((await blockedReader.read()).value, 7);
await writing;
await writer.close();
assert.equal((await blockedReader.read()).done, true);
writer.releaseLock();
blockedReader.releaseLock();
console.log("backpressure");

for (const format of ["gzip", "deflate", "deflate-raw"]) {
  const compression = new CompressionStream(format);
  const compressionWriter = compression.writable.getWriter();
  const compressionReader = compression.readable.getReader();
  let seed = 42;
  const bytes = Uint8Array.from({ length: 256 * 1024 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
  const writing = compressionWriter.write(bytes);
  writing.catch(() => {});
  assert.equal((await compressionReader.read()).done, false);
  await compressionReader.cancel("stop");
  await Promise.allSettled([writing]);
  await assert.rejects(compressionWriter.closed);
  compressionWriter.releaseLock();
  compressionReader.releaseLock();
}
console.log("incremental compression/cancel");

let returned = false;
const breaking = Readable.fromWeb(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array([1])); },
  cancel() { returned = true; },
}));
for await (const chunk of breaking) { assert.equal(chunk[0], 1); break; }
await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(returned, true);
assert.equal(breaking.listenerCount("data"), 0);
console.log("iterator cancellation");

let failed;
const failedSink = Writable.fromWeb(new WritableStream({ write() { throw new Error("sink failed"); } }));
await new Promise(resolve => { failedSink.once("error", error => { failed = error.message; resolve(); }); failedSink.write("x"); });
assert.equal(failed, "sink failed");
console.log("writable errors");
