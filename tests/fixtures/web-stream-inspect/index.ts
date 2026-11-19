// util.inspect, Bun.inspect and console.log of every web stream class print Bun's
// summary (`ReadableStream { locked: false, state: 'readable', supportsBYOB: false }`),
// never the implementation's internal fields.
import util from "node:util";

const custom = Symbol.for("nodejs.util.inspect.custom");
const show = (label: string, value: unknown) => console.log(`${label}: ${util.inspect(value)}`);

let defaultController: unknown;
let byteController: unknown;
let writableController: unknown;
let transformController: unknown;
new ReadableStream({ start(controller) { defaultController = controller; } });
new ReadableStream({ type: "bytes", start(controller) { byteController = controller; } });
new WritableStream({ start(controller) { writableController = controller; } });
new TransformStream({ start(controller) { transformController = controller; } });

show("readable", new ReadableStream());
show("bytes", new ReadableStream({ type: "bytes" }));
show("closed", new ReadableStream({ start(controller) { controller.close(); } }));
show("errored", new ReadableStream({ start(controller) { controller.error(new Error("boom")); } }));
const locked = new ReadableStream();
const pendingReader = locked.getReader();
void pendingReader.read();
show("locked", locked);
show("reader with a pending read", pendingReader);
show("byob reader", new ReadableStream({ type: "bytes" }).getReader({ mode: "byob" }));
show("default controller", defaultController);
show("byte controller", byteController);
show("writable", new WritableStream());
show("errored writable", new WritableStream({ start(controller) { controller.error(new Error("boom")); } }));
// A zero high-water mark keeps `ready` pending: the Browser engine cannot read the state
// of a promise the host resolved itself.
const writer = new WritableStream({}, { highWaterMark: 0 }).getWriter();
show("writer", writer);
writer.releaseLock();
const released = util.inspect(writer);
console.log("released writer:", released.includes("stream: undefined"), released.includes("desiredSize: null"));
show("writable controller", writableController);
show("transform", new TransformStream());
show("transform controller", transformController);
show("byte length strategy", new ByteLengthQueuingStrategy({ highWaterMark: 16 }));
show("count strategy", new CountQueuingStrategy({ highWaterMark: 8 }));
show("text encoder stream", new TextEncoderStream());
show("text decoder stream", new TextDecoderStream("utf-8", { fatal: true, ignoreBOM: true }));
show("compression stream", new CompressionStream("gzip"));
show("decompression stream", new DecompressionStream("deflate"));
class Subclass extends ReadableStream {}
show("subclass", new Subclass());

// Nesting and depth limits: each level hands `depth - 1` to the inner inspect.
show("nested", { a: { b: new ReadableStream() }, list: [new WritableStream()] });
show("too deep", { a: { b: { c: new ReadableStream() } } });
show("transform in an array", [new TransformStream()]);
console.log("depth 0:", util.inspect(new TransformStream(), { depth: 0 }));
console.log("depth 1:", util.inspect(new TransformStream(), { depth: 1 }));
console.log("without the custom method:", util.inspect(new TransformStream(), { customInspect: false }));
console.log("class names:", [ReadableStream, ReadableStreamDefaultReader, WritableStream, WritableStreamDefaultWriter, TransformStream, CountQueuingStrategy].map(constructor => constructor.name).join(" "));
console.log("colors:", JSON.stringify(util.inspect(new ReadableStream(), { colors: true })));

// Bun.inspect and console.log go through the same method.
console.log("Bun.inspect:", Bun.inspect(new ReadableStream({ type: "bytes" })));
console.log(new WritableStream());
console.log([new ReadableStream()]);

// The method itself: depth < 0 and another receiver return the receiver.
const stream = new ReadableStream();
const method = Reflect.get(ReadableStream.prototype, custom);
console.log("depth -1 returns the stream:", method.call(stream, -1, {}) === stream);
const other = {};
console.log("another receiver returns it:", method.call(other, 2, {}) === other);
console.log("called directly:", method.call(stream, 2, {}));
console.log("descriptor:", JSON.stringify(Object.getOwnPropertyDescriptor(ReadableStream.prototype, custom), (key, value) => typeof value === "function" ? typeof value : value));
console.log("prototype keeps default formatting:", util.inspect(ReadableStream.prototype).includes("[ReadableStream]"));
for (const name of ["TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream"] as const) {
  const prototype = globalThis[name].prototype;
  try {
    Reflect.get(prototype, custom).call({}, 2, {});
    console.log(`${name}: no error`);
  } catch (error) {
    console.log(`${name}: ${(error as TypeError).name} ${(error as { code?: string }).code} ${(error as TypeError).message}`);
  }
}

// A BYOB request exists only during a pull.
let request = "";
const bytes = new ReadableStream({
  type: "bytes",
  autoAllocateChunkSize: 4,
  pull(controller) {
    const byob = controller.byobRequest;
    if (!byob) throw new Error("missing byobRequest");
    request = util.inspect(byob);
    if (byob.view) byob.view[0] = 1;
    byob.respond(1);
    controller.close();
  },
});
await bytes.getReader().read();
console.log(`byob request: ${request}`);
