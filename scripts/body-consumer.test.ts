import { expect, test } from "bun:test";
import { bodyConsumerFactory, bodyConsumerSources } from "./body-consumer-factory.ts";

const { web } = bodyConsumerFactory(bodyConsumerSources());
function readerOnly<T>(source: UnderlyingDefaultSource<T> = {}) {
  const stream = new ReadableStream<T>(source, { highWaterMark: 0 });
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
  Object.defineProperty(stream, "values", { value: undefined });
  return stream;
}
function bytes(value: string) { return new TextEncoder().encode(value); }

test("actual Response and Request consume reader-only native bodies", async () => {
  for (const Ctor of [web.Response, web.Request]) {
    const stream = readerOnly({ start(c) { c.enqueue(bytes('{"value":')); c.enqueue(bytes('"ssr"}')); c.close(); } });
    const body = Ctor === web.Response ? new web.Response(stream) : new web.Request("http://localhost/", { method: "POST", body: stream, duplex: "half" });
    expect(body.bodyUsed).toBe(false);
    expect(await body.json()).toEqual({ value: "ssr" });
    expect(body.bodyUsed).toBe(true);
    expect(stream.locked).toBe(false);
    await expect(body.text()).rejects.toThrow("Body already used");
  }
});

test("reader-only body preserves read rejection identity and releases its lock", async () => {
  for (const reason of [undefined, null, new Error("read failed"), { marker: "read" }]) {
    let cancelled = false;
    const stream = readerOnly({ pull(c) { c.error(reason); }, cancel() { cancelled = true; } });
    const body = new web.Response(stream);
    await expect(body.text()).rejects.toBe(reason);
    expect(body.bodyUsed).toBe(true);
    expect(stream.locked).toBe(false);
    expect(cancelled).toBe(false);
  }
});

test("reader-only body rejects a locked stream without disturbing its reader", async () => {
  const stream = readerOnly({ start(c) { c.enqueue(bytes("owned")); c.close(); } });
  const reader = stream.getReader();
  try {
    await expect(new web.Response(stream).text()).rejects.toBeInstanceOf(TypeError);
    expect(stream.locked).toBe(true);
    expect((await reader.read()).value).toEqual(bytes("owned"));
  } finally { reader.releaseLock(); }
});

test("invalid body chunks cancel once, release the lock, and retain conversion errors", async () => {
  let cancellations = 0;
  const cancellation = new Error("cancel failed");
  const stream = readerOnly<unknown>({ pull(c) { c.enqueue({ invalid: true }); }, cancel(reason) { expect(reason).toBeUndefined(); cancellations++; throw cancellation; } });
  await expect(new web.Response(stream).text()).rejects.toThrow("Expected an ArrayBuffer or ArrayBufferView");
  expect(cancellations).toBe(1);
  expect(stream.locked).toBe(false);
});

test("body chunks keep string encoding and view boundaries", async () => {
  const stream = readerOnly<string | Uint8Array | DataView>({ start(c) {
    c.enqueue("α"); c.enqueue(new Uint8Array([0, 65, 0]).subarray(1, 2)); c.enqueue(new DataView(new Uint8Array([0, 66, 0]).buffer, 1, 1)); c.close();
  } });
  expect(await new web.Response(stream).text()).toBe("αAB");
});

test("reader iteration cancels on early return and preserves cancellation rejection identity", async () => {
  const { body } = bodyConsumerFactory(bodyConsumerSources());
  for (const reason of [undefined, null, { marker: "cancel" }]) {
    let cancellations = 0;
    const stream = readerOnly({ pull(c) { c.enqueue(bytes("first")); }, cancel(value) { expect(value).toBeUndefined(); cancellations++; return Promise.reject(reason); } });
    const iterator = body.values(stream);
    expect((await iterator.next()).value).toEqual(bytes("first"));
    await expect(iterator.return()).rejects.toBe(reason);
    expect(cancellations).toBe(1);
    expect(stream.locked).toBe(false);
  }
});

test("reader iteration keeps consumer throw identity when cancellation also rejects", async () => {
  const { body } = bodyConsumerFactory(bodyConsumerSources());
  const failure = { marker: "consumer" };
  const stream = readerOnly({ pull(c) { c.enqueue(1); }, cancel() { throw new Error("cancel"); } });
  async function consume() { for await (const _chunk of body.values(stream)) throw failure; }
  await expect(consume()).rejects.toBe(failure);
  expect(stream.locked).toBe(false);
});

test("generic async iterable response bodies still close their iterator", async () => {
  let closed = 0;
  async function* source() { try { yield bytes("generic"); } finally { closed++; } }
  expect(await new web.Response(source()).text()).toBe("generic");
  expect(closed).toBe(1);
});

test("actual text and blob consumers read native streams without iteration", async () => {
  const { consumers } = bodyConsumerFactory(bodyConsumerSources());
  for (const consume of [consumers.text, async (stream: unknown) => (await consumers.blob(stream)).text()]) {
    const stream = readerOnly({ start(c) { c.enqueue(bytes("body")); c.close(); } });
    expect(await consume(stream)).toBe("body");
    expect(stream.locked).toBe(false);
  }
});

test("reader-backed consumers do not unwrap Promise or thenable chunks", async () => {
  const { consumers, body } = bodyConsumerFactory(bodyConsumerSources());
  let calls = 0;
  const value = { then(resolve: (value: string) => void) { calls++; resolve("unwrapped"); } };
  const stream = readerOnly({ start(c) { c.enqueue(value); c.close(); } });
  const iterator = body.values(stream);
  expect((await iterator.next()).value).toBe(value);
  await iterator.return();
  expect(calls).toBe(0);
  const promise = Promise.resolve(bytes("not a byte chunk"));
  await expect(consumers.text(readerOnly({ start(c) { c.enqueue(promise); c.close(); } }))).rejects.toBeInstanceOf(TypeError);
  await expect(new web.Response(readerOnly({ start(c) { c.enqueue(promise); c.close(); } })).text()).rejects.toBeInstanceOf(TypeError);
});

for (const name of ["text", "blob"] as const) {
  test(`${name} preserves reader errors and locks without cancelling read failures`, async () => {
    const { consumers } = bodyConsumerFactory(bodyConsumerSources());
    for (const reason of [undefined, null, { marker: name }]) {
      let cancellations = 0;
      const stream = readerOnly({ pull(c) { c.error(reason); }, cancel() { cancellations++; } });
      await expect(consumers[name](stream)).rejects.toBe(reason);
      expect(cancellations).toBe(0);
      expect(stream.locked).toBe(false);
    }
    const stream = readerOnly({ start(c) { c.close(); } });
    const reader = stream.getReader();
    try { await expect(consumers[name](stream)).rejects.toBeInstanceOf(TypeError); expect(stream.locked).toBe(true); }
    finally { reader.releaseLock(); }
  });
}

test("text cancels on conversion error without masking it with a cancellation error", async () => {
  const { consumers } = bodyConsumerFactory(bodyConsumerSources());
  let cancellations = 0;
  const stream = readerOnly({ pull(c) { c.enqueue(123); }, cancel(reason) { expect(reason).toBeUndefined(); cancellations++; throw new Error("cancel"); } });
  await expect(consumers.text(stream)).rejects.toBeInstanceOf(TypeError);
  expect(cancellations).toBe(1);
  expect(stream.locked).toBe(false);
});

test("generic iterables keep async and sync chunk semantics and cleanup", async () => {
  const { consumers } = bodyConsumerFactory(bodyConsumerSources());
  expect(await consumers.text([Promise.resolve(bytes("sync"))])).toBe("sync");
  expect(await (await consumers.blob([bytes("a"), "b"])).text()).toBe("ab");
  let closed = 0;
  async function* invalid() { try { yield 123; } finally { closed++; } }
  await expect(consumers.text(invalid())).rejects.toBeInstanceOf(TypeError);
  expect(closed).toBe(1);
  const reason = { marker: "next" };
  const source = { [Symbol.asyncIterator]() { return this; }, next() { return Promise.reject(reason); }, return() { throw new Error("must not close rejected next"); } };
  await expect(consumers.text(source)).rejects.toBe(reason);
  await expect(consumers.blob(source)).rejects.toBe(reason);
});

test("reader iterator queues return behind a pending read and forwards its reason", async () => {
  const { body } = bodyConsumerFactory(bodyConsumerSources());
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const reason = { marker: "return" };
  const cancellations: unknown[] = [];
  const stream = readerOnly<Uint8Array>({ start(value) { controller = value; }, cancel(value) { cancellations.push(value); } });
  const iterator = body.values(stream);
  const next = iterator.next();
  const finish = iterator.return(reason);
  expect(cancellations).toEqual([]);
  if (!controller) throw new Error("stream controller missing");
  controller.enqueue(bytes("pending"));
  expect((await next).value).toEqual(bytes("pending"));
  expect(await finish).toEqual({ done: true, value: reason });
  expect(cancellations).toEqual([reason]);
  expect(stream.locked).toBe(false);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});
