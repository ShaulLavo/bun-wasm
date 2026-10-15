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
