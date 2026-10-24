import assert from "node:assert/strict";

function decoder(label: unknown = "utf-8", options: unknown = {}): TextDecoderStream {
  const stream: unknown = Reflect.construct(TextDecoderStream, [label, options]);
  if (!(stream instanceof TextDecoderStream)) throw new Error("Expected the decoder stream instance");
  return stream;
}
function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected an exception");
}
async function text(stream: TextDecoderStream, chunks: unknown[]): Promise<string> {
  const reading = (async () => {
    let output = "";
    for await (const chunk of stream.readable) output += chunk;
    return output;
  })();
  const writer = stream.writable.getWriter();
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
  writer.releaseLock();
  return reading;
}

const order: string[] = [];
const label = { [Symbol.toPrimitive](hint: string) { order.push("label:" + hint); return "UTF-8"; } };
const options = new Proxy({}, { get(_target, key) { order.push(String(key)); return key === "fatal"; } });
const converted = decoder(label, options);
assert.equal(order.filter(step => step === "label:string").length, 1);
assert.deepEqual(order.filter(step => step !== "label:string"), ["fatal", "ignoreBOM"]);
assert.deepEqual([converted.encoding, converted.fatal, converted.ignoreBOM], ["utf-8", true, false]);
assert.equal(await text(converted, [new Uint8Array([65])]), "A");
console.log("conversion and property-read order");

const sentinel = new Error("original error");
assert.equal(thrown(() => decoder({ toString() { throw sentinel; } }, options)), sentinel);
assert.equal(thrown(() => decoder("utf-8", { get fatal() { throw sentinel; } })), sentinel);
assert.equal(thrown(() => decoder("utf-8", { get ignoreBOM() { throw sentinel; } })), sentinel);
assert.equal(thrown(() => decoder("utf-8", new Proxy({}, { get() { throw sentinel; } }))), sentinel);
console.log("coercion and getter error identity");

for (const invalid of [Symbol("label"), { toString() { return Symbol("label"); } }]) {
  assert.ok(thrown(() => decoder(invalid)) instanceof TypeError);
}
for (const invalid of [true, 1, "options", Symbol("options")]) {
  assert.ok(thrown(() => decoder("utf-8", invalid)) instanceof TypeError);
}
assert.ok(thrown(() => decoder("not-an-encoding")) instanceof RangeError);
for (const accepted of [null, undefined, () => undefined, Object.create({ fatal: false, ignoreBOM: false })]) {
  assert.equal(await text(decoder("utf-8", accepted), [new Uint8Array([66])]), "B");
}
console.log("dictionary and label validation");

const bytes = new Uint8Array([0, 239, 187, 191, 65, 0]);
assert.equal(await text(decoder(), [new DataView(bytes.buffer, 1, 4)]), "A");
assert.equal(await text(decoder("utf-8", { ignoreBOM: true }), [bytes.subarray(1, 5)]), "\ufeffA");
assert.equal(await text(decoder(), [new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80])]), "😀");
assert.equal(await text(decoder(), [new Uint8Array([0xc3])]), "�");
console.log("views, BOM, split bytes and flush");

const encoder = new TextEncoderStream();
const encoding = new Response(encoder.readable).bytes();
const encoderWriter = encoder.writable.getWriter();
for (const chunk of ["\ud83d", "\ude00", "\ud800", { toString() { return "!"; } }]) await encoderWriter.write(chunk);
await encoderWriter.close();
encoderWriter.releaseLock();
assert.deepEqual(Array.from(await encoding), [240, 159, 152, 128, 239, 191, 189, 33]);
console.log("surrogates and string coercion");

for (const constructor of [TextDecoderStream, TextEncoderStream]) {
  const instance = new constructor();
  assert.equal(Object.prototype.toString.call(instance), `[object ${constructor.name}]`);
  for (const member of ["encoding", "readable", "writable"]) {
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, member);
    assert.equal(descriptor?.enumerable, true);
    assert.ok(descriptor?.get);
    assert.ok(thrown(() => Reflect.apply(descriptor.get, {}, [])) instanceof TypeError);
  }
  const reader = instance.readable.getReader();
  const writer = instance.writable.getWriter();
  assert.deepEqual([instance.readable.locked, instance.writable.locked], [true, true]);
  assert.ok(thrown(() => instance.readable.getReader()) instanceof TypeError);
  assert.ok(thrown(() => instance.writable.getWriter()) instanceof TypeError);
  const done = reader.read();
  await writer.close();
  assert.equal((await done).done, true);
  reader.releaseLock(); writer.releaseLock();
  assert.deepEqual([instance.readable.locked, instance.writable.locked], [false, false]);
}
console.log("brands, controllers, locks and close");

async function writeFailure(stream: TextDecoderStream | TextEncoderStream, chunk: unknown): Promise<unknown[]> {
  const reader = stream.readable.getReader(); const writer = stream.writable.getWriter();
  const reading = reader.read().catch(error => error);
  const closed = writer.closed.catch(error => error);
  const writing = writer.write(chunk).catch(error => error);
  const result = [await writing, await reading, await closed];
  reader.releaseLock(); writer.releaseLock();
  assert.deepEqual([stream.readable.locked, stream.writable.locked], [false, false]);
  return result;
}
assert.deepEqual(await writeFailure(new TextEncoderStream(), { toString() { throw sentinel; } }), [sentinel, sentinel, sentinel]);
const failure = await writeFailure(decoder("utf-8", { fatal: true }), new Uint8Array([0xff]));
assert.ok(failure[0] instanceof TypeError);
assert.equal(failure[0], failure[1]); assert.equal(failure[0], failure[2]);
console.log("write error identity and unlock");

const fatal = decoder("utf-8", { fatal: true });
const fatalReader = fatal.readable.getReader(); const fatalWriter = fatal.writable.getWriter();
const fatalReading = fatalReader.read().catch(error => error);
const fatalClosed = fatalWriter.closed.catch(error => error);
await fatalWriter.write(new Uint8Array([0xc3]));
const flushError = await fatalWriter.close().catch(error => error);
assert.ok(flushError instanceof TypeError);
assert.equal(await fatalReading, flushError); assert.equal(await fatalClosed, flushError);
fatalReader.releaseLock(); fatalWriter.releaseLock();
console.log("flush error identity");

for (const format of ["gzip", "deflate", "deflate-raw"]) {
  const compressed = await new Response(ReadableStream.from([new Uint8Array([65, 66]), new Uint8Array([67])]).pipeThrough(new CompressionStream(format))).bytes();
  const split = ReadableStream.from(Array.from(compressed, byte => new Uint8Array([byte])));
  assert.equal(await new Response(split.pipeThrough(new DecompressionStream(format))).text(), "ABC");
}
console.log("compression byte flow");
