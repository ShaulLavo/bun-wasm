import assert from "node:assert/strict";

const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
const errorKey = Symbol.for("nodejs.webstream.controllerErrorFunction");
const mode = process.argv[2];
const native = { ReadableStream, WritableStream, TransformStream };

if (mode === "own" || mode === "browser") {
  // Node 26 moved its hooks to prototype getters, so its default path would
  // otherwise hide the instance-property collision seen in Node 24 and 25.
  for (const Ctor of [ReadableStream, WritableStream]) {
    Reflect.deleteProperty(Ctor.prototype, closedKey);
    Reflect.deleteProperty(Ctor.prototype, errorKey);
  }
}
if (mode === "own") {
  for (const name of ["ReadableStream", "WritableStream"] as const) {
    const Ctor = globalThis[name];
    globalThis[name] = new Proxy(Ctor, {
      construct(target, args, newTarget) {
        const stream = Reflect.construct(target, args, newTarget);
        // Use assignment, just like the native Node 24/25 constructors.
        stream[closedKey] = { promise: Promise.resolve() };
        stream[errorKey] = () => {};
        return stream;
      },
    });
  }
}
const before = { ReadableStream, WritableStream, TransformStream };
const readable = new ReadableStream({ start(controller) { controller.close(); } });
const writable = new WritableStream();
const hooks = [Reflect.get(readable, closedKey), Reflect.get(writable, closedKey)];
const { installNativeStreamState } = await import("../src/native-stream-state.ts");
const dispose = installNativeStreamState();
try {
  const stream = new ReadableStream({ start(controller) { controller.close(); } });
  const hasNativeHooks = hooks[0] !== undefined;
  for (const name of ["ReadableStream", "WritableStream", "TransformStream"] as const) {
    assert.equal(globalThis[name] === before[name], hasNativeHooks);
    assert.equal(globalThis[name].prototype, before[name].prototype);
  }
  if (hasNativeHooks) {
    assert.equal(Reflect.get(readable, closedKey), hooks[0]);
    assert.equal(Reflect.get(writable, closedKey), hooks[1]);
  }
  assert.ok(stream instanceof native.ReadableStream);
  assert.equal(stream.locked, false);
  await Reflect.get(stream, closedKey).promise;
  const sink = new WritableStream();
  await sink.close();
  await Reflect.get(sink, closedKey).promise;
  const transform = new TransformStream();
  const reader = transform.readable.getReader();
  const writer = transform.writable.getWriter();
  await writer.close();
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  writer.releaseLock();
  if (!hasNativeHooks) {
    const errored = new ReadableStream();
    const failure = new Error("native bridge error");
    const completion = Reflect.get(errored, closedKey).promise;
    Reflect.get(errored, errorKey)(failure);
    await assert.rejects(completion, error => error === failure);
  }
} finally {
  dispose();
  await writable.close();
}
console.log(`${mode}: native stream construction and completion passed on ${process.version}`);
