import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { installReadableStreamIteration } from "../src/native-readable-iterator.ts";

const iterationKeys = ["values", Symbol.asyncIterator];

function streamClass(missing: readonly PropertyKey[] = iterationKeys) {
  class Stream<R = unknown> extends ReadableStream<R> {}
  for (const key of missing) Object.defineProperty(Stream.prototype, key, { configurable: true, writable: true, value: undefined });
  Reflect.apply(installReadableStreamIteration, undefined, [Stream]);
  return Stream;
}

function returnValue(iterator: AsyncIterator<unknown, unknown>, value?: unknown) {
  if (!iterator.return) throw new TypeError("Iterator return missing");
  return iterator.return(value);
}

async function rejection(promise: Promise<unknown>): Promise<{ reason: unknown }> {
  try { await promise; }
  catch (reason) { return { reason }; }
  throw new Error("Expected rejection");
}

test("fills missing aliases without replacing complete native implementations", () => {
  const originalValues = ReadableStream.prototype.values;
  const originalAlias = ReadableStream.prototype[Symbol.asyncIterator];
  installReadableStreamIteration(ReadableStream);
  expect(ReadableStream.prototype.values).toBe(originalValues);
  expect(ReadableStream.prototype[Symbol.asyncIterator]).toBe(originalAlias);
  const Stream = streamClass();
  expect(Stream.prototype.values).toBe(Stream.prototype[Symbol.asyncIterator]);
  expect(Stream.prototype.values.name).toBe("values");
  expect(Stream.prototype.values.length).toBe(0);
  expect(Object.getOwnPropertyDescriptor(Stream.prototype, "values")).toEqual({
    configurable: true, enumerable: true, writable: true, value: Stream.prototype.values,
  });
  const installed = Stream.prototype.values;
  Reflect.apply(installReadableStreamIteration, undefined, [Stream]);
  expect(Stream.prototype.values).toBe(installed);
});

test("reuses the remaining native method when only one alias is missing", () => {
  for (const key of iterationKeys) {
    const Stream = streamClass([key]);
    const expected = key === "values" ? ReadableStream.prototype[Symbol.asyncIterator] : ReadableStream.prototype.values;
    expect(Stream.prototype.values).toBe(expected);
    expect(Stream.prototype[Symbol.asyncIterator]).toBe(expected);
  }
});

test("acquires a reader immediately but does not read ahead", async () => {
  const Stream = streamClass();
  let pulls = 0;
  const stream = new Stream<number>({
    pull(controller) {
      controller.enqueue(++pulls);
      if (pulls === 3) controller.close();
    },
  }, { highWaterMark: 0 });
  const iterator = stream.values();
  expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
  expect(stream.locked).toBe(true);
  expect(() => stream.getReader()).toThrow(TypeError);
  await Promise.resolve();
  expect(pulls).toBe(0);
  expect(await iterator.next()).toEqual({ done: false, value: 1 });
  await Promise.resolve();
  expect(pulls).toBe(1);
  const rest = [];
  for await (const value of iterator) rest.push(value);
  expect(rest).toEqual([2, 3]);
  expect(stream.locked).toBe(false);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test("uses the reader tracking wrapper installed before iteration", async () => {
  class Stream<R = unknown> extends ReadableStream<R> {}
  for (const key of iterationKeys) Object.defineProperty(Stream.prototype, key, { configurable: true, value: undefined });
  let acquisitions = 0;
  const getReader: (this: unknown) => ReadableStreamDefaultReader<unknown> = Stream.prototype.getReader;
  Object.defineProperty(Stream.prototype, "getReader", { configurable: true, value(this: unknown) {
    acquisitions++;
    return getReader.call(this);
  } });
  Reflect.apply(installReadableStreamIteration, undefined, [Stream]);
  const stream = new Stream({ start(controller) { controller.close(); } });
  Object.defineProperty(stream, "getReader", { value() { throw new Error("must use the captured prototype method"); } });
  const iterator = stream.values();
  expect(acquisitions).toBe(1);
  expect(stream.locked).toBe(true);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(stream.locked).toBe(false);
});

test("for-await uses the installed stream alias and releases on completion", async () => {
  const Stream = streamClass();
  const stream = new Stream({ start(controller) { controller.enqueue("a"); controller.enqueue("b"); controller.close(); } });
  const values = [];
  for await (const value of stream) values.push(value);
  expect(values).toEqual(["a", "b"]);
  expect(stream.locked).toBe(false);
});

test("empty streams release their reader at the first done result", async () => {
  const Stream = streamClass();
  const stream = new Stream({ start(controller) { controller.close(); } });
  const iterator = stream.values();
  expect(stream.locked).toBe(true);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(stream.locked).toBe(false);
  expect(await returnValue(iterator, "finished")).toEqual({ done: true, value: "finished" });
});

test("promise and thenable chunks are not assimilated", async () => {
  const Stream = streamClass();
  let thenCalls = 0;
  const thenable = { then() { thenCalls++; throw new Error("must not assimilate"); } };
  const promise = Promise.resolve("chunk");
  const stream = new Stream({ start(controller) { controller.enqueue(promise); controller.enqueue(thenable); controller.close(); } });
  const values = [];
  for await (const value of stream) values.push(value);
  expect(values[0]).toBe(promise);
  expect(values[1]).toBe(thenable);
  expect(thenCalls).toBe(0);
  expect(stream.locked).toBe(false);
});

test("read errors release the lock and preserve even falsy reasons", async () => {
  const Stream = streamClass();
  for (const reason of [new Error("read failed"), undefined, null, false]) {
    const stream = new Stream({ start(controller) { controller.error(reason); } });
    const iterator = stream.values();
    expect((await rejection(iterator.next())).reason).toBe(reason);
    expect(stream.locked).toBe(false);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await returnValue(iterator, "after error")).toEqual({ done: true, value: "after error" });
  }
});

test("early return cancels before the first next and waits to release the lock", async () => {
  const Stream = streamClass();
  const started = Promise.withResolvers<void>();
  const cancellation = Promise.withResolvers<void>();
  const reason = Promise.resolve("stop");
  let received: unknown;
  let pulls = 0;
  const stream = new Stream({
    pull() { pulls++; },
    cancel(value) { received = value; started.resolve(); return cancellation.promise; },
  }, { highWaterMark: 0 });
  const iterator = stream.values();
  const returned = returnValue(iterator, reason);
  await started.promise;
  expect(received).toBe(reason);
  expect(pulls).toBe(0);
  expect(stream.locked).toBe(true);
  expect(() => stream.getReader()).toThrow(TypeError);
  cancellation.resolve();
  const result = await returned;
  expect(result.done).toBe(true);
  expect(result.value).toBe(reason);
  expect(stream.locked).toBe(false);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test("cancel rejection releases the lock, preserves the reason, and leaves the iterator done", async () => {
  const Stream = streamClass();
  for (const reason of [new Error("cancel failed"), undefined, null, false]) {
    const stream = new Stream({ cancel() { return Promise.reject(reason); } });
    const iterator = stream.values();
    expect((await rejection(returnValue(iterator, "stop"))).reason).toBe(reason);
    expect(stream.locked).toBe(false);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await returnValue(iterator, "again")).toEqual({ done: true, value: "again" });
  }
});

test("queued calls recover after a pending cancellation rejects", async () => {
  const Stream = streamClass();
  const started = Promise.withResolvers<void>();
  const canceled = Promise.withResolvers<void>();
  const stream = new Stream({ cancel() { started.resolve(); return canceled.promise; } });
  const iterator = stream.values();
  const returned = rejection(returnValue(iterator, "stop"));
  const next = iterator.next();
  const repeated = returnValue(iterator, "again");
  await started.promise;
  expect(stream.locked).toBe(true);
  canceled.reject(false);
  expect((await returned).reason).toBe(false);
  expect(await next).toEqual({ done: true, value: undefined });
  expect(await repeated).toEqual({ done: true, value: "again" });
  expect(stream.locked).toBe(false);
});

test("a synchronous cancel throw preserves its reason and releases the reader", async () => {
  const Stream = streamClass();
  const reason = new Error("synchronous cancel");
  const stream = new Stream({ cancel() { throw reason; } });
  const iterator = stream.values();
  expect((await rejection(returnValue(iterator))).reason).toBe(reason);
  expect(stream.locked).toBe(false);
});

test("preventCancel releases without canceling and leaves unread chunks available", async () => {
  const Stream = streamClass();
  let canceled = false;
  const stream = new Stream<number>({
    start(controller) { controller.enqueue(1); controller.enqueue(2); controller.close(); },
    cancel() { canceled = true; },
  });
  const iterator = stream.values({ preventCancel: true });
  expect(await iterator.next()).toEqual({ done: false, value: 1 });
  expect(await returnValue(iterator, "stop")).toEqual({ done: true, value: "stop" });
  expect(canceled).toBe(false);
  expect(stream.locked).toBe(false);
  const reader = stream.getReader();
  expect(await reader.read()).toEqual({ done: false, value: 2 });
  reader.releaseLock();
});

test("preventCancel also supports return before the first next", async () => {
  const Stream = streamClass();
  let canceled = false;
  const stream = new Stream({ cancel() { canceled = true; } }, { highWaterMark: 0 });
  const iterator = stream.values({ preventCancel: true });
  expect(await returnValue(iterator)).toEqual({ done: true, value: undefined });
  expect(stream.locked).toBe(false);
  expect(canceled).toBe(false);
});

test("queues concurrent next and return calls without canceling a pending read", async () => {
  const Stream = streamClass();
  const requested = Promise.withResolvers<ReadableStreamDefaultController<number>>();
  const cancelStarted = Promise.withResolvers<void>();
  const cancelFinished = Promise.withResolvers<void>();
  const events: string[] = [];
  const stream = new Stream<number>({
    pull(controller) { requested.resolve(controller); },
    cancel(reason) { events.push(String(reason)); cancelStarted.resolve(); return cancelFinished.promise; },
  }, { highWaterMark: 0 });
  const iterator = stream.values();
  const first = iterator.next();
  const second = iterator.next();
  const returned = returnValue(iterator, "stop");
  const after = iterator.next();
  const repeated = returnValue(iterator, "again");
  const controller = await requested.promise;
  expect(events).toEqual([]);
  controller.enqueue(1);
  expect(await first).toEqual({ done: false, value: 1 });
  expect(events).toEqual([]);
  controller.enqueue(2);
  expect(await second).toEqual({ done: false, value: 2 });
  await cancelStarted.promise;
  expect(events).toEqual(["stop"]);
  expect(stream.locked).toBe(true);
  cancelFinished.resolve();
  expect(await returned).toEqual({ done: true, value: "stop" });
  expect(await after).toEqual({ done: true, value: undefined });
  expect(await repeated).toEqual({ done: true, value: "again" });
  expect(stream.locked).toBe(false);
});

test("queued calls after a read rejection do not repeat the error or cancel", async () => {
  const Stream = streamClass();
  const requested = Promise.withResolvers<ReadableStreamDefaultController<unknown>>();
  let canceled = false;
  const stream = new Stream({ pull(controller) { requested.resolve(controller); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  const iterator = stream.values();
  const first = rejection(iterator.next());
  const second = iterator.next();
  const returned = returnValue(iterator, "stop");
  (await requested.promise).error(null);
  expect((await first).reason).toBe(null);
  expect(await second).toEqual({ done: true, value: undefined });
  expect(await returned).toEqual({ done: true, value: "stop" });
  expect(canceled).toBe(false);
  expect(stream.locked).toBe(false);
});

test("validates receivers and options synchronously before acquiring the reader", async () => {
  const Stream = streamClass();
  const values = Stream.prototype.values;
  const stream = new Stream();
  for (const options of [false, 1, "", Symbol("bad"), 1n]) {
    expect(() => Reflect.apply(values, stream, [options])).toThrow(TypeError);
    expect(stream.locked).toBe(false);
  }
  let optionReads = 0;
  const options = { get preventCancel() { optionReads++; return true; } };
  for (const receiver of [null, undefined, {}, Object.create(Stream.prototype), { getReader() { throw new Error("fake"); } }]) {
    expect(() => Reflect.apply(values, receiver, [options])).toThrow(TypeError);
  }
  expect(optionReads).toBe(0);
  const failure = new Error("options failed");
  expect(() => Reflect.apply(values, stream, [{ get preventCancel() { throw failure; } }])).toThrow(failure);
  expect(stream.locked).toBe(false);
  const reader = stream.getReader();
  expect(() => Reflect.apply(values, stream, [options])).toThrow(TypeError);
  expect(optionReads).toBe(1);
  reader.releaseLock();
  const iterator = stream.values();
  expect((await rejection(Reflect.apply(iterator.next, {}, []))).reason).toBeInstanceOf(TypeError);
  expect((await rejection(returnValue(Object.assign({}, iterator, { return: iterator.return })))).reason).toBeInstanceOf(TypeError);
  expect((await rejection(Reflect.apply(iterator.next, Object.create(Object.getPrototypeOf(iterator)), []))).reason).toBeInstanceOf(TypeError);
  await returnValue(iterator);
});

test("matches native Node option conversion and return-value semantics", () => {
  const result = spawnSync("node", ["--input-type=module", "--eval", `
    import { strict as assert } from "node:assert";
    import { installReadableStreamIteration } from ${JSON.stringify(new URL("../src/native-readable-iterator.ts", import.meta.url).href)};
    class Stream extends ReadableStream {}
    for (const key of ["values", Symbol.asyncIterator]) Object.defineProperty(Stream.prototype, key, { configurable: true, value: undefined });
    installReadableStreamIteration(Stream);
    async function observe(Ctor) {
      const output = [];
      for (const option of [undefined, null, false, 1, "", Symbol(), 1n, () => {}, { preventCancel: "yes" }]) {
        const stream = new Ctor();
        try { const iterator = stream.values(option); output.push(stream.locked, await iterator.return("stop"), stream.locked); }
        catch (error) { output.push(error.name, stream.locked); }
      }
      let reads = 0;
      const options = { get preventCancel() { reads++; return true; } };
      assert.throws(() => Ctor.prototype.values.call({}, options), TypeError);
      output.push(reads);
      const stream = new Ctor({ start(c) { c.close(); } });
      const iterator = stream.values(options);
      output.push(reads, await iterator.next());
      const reason = Promise.resolve("return value");
      const returned = await iterator.return(reason);
      assert.equal(returned.value, reason);
      output.push(returned.done, await iterator.next());
      return output;
    }
    assert.deepEqual(await observe(Stream), await observe(ReadableStream));
    console.log("Node native parity passed");
  `], { encoding: "utf8", timeout: 10000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(result.stdout).toContain("Node native parity passed");
});
