import { expect, test } from "bun:test";
import { bodyConsumerFactory, bodyConsumerSources } from "./body-consumer-factory.ts";

const { web } = bodyConsumerFactory(bodyConsumerSources());
function readerOnly<T>(source: UnderlyingSource<T> = {}) {
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
  const stream = readerOnly({ pull(c) { c.enqueue({ invalid: true }); }, cancel(reason) { expect(reason).toBeUndefined(); cancellations++; throw cancellation; } });
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
