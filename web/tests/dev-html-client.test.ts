import { expect, test } from "bun:test";
import { parseConfig, parseNotice, parseStamp, readHtml } from "../src/dev-html-client";

const stamp = { server: "instance_1", revision: 1 };
const config = { stamp, paths: { client: "/_bun/wasm-dev/instance_1/client.js", events: "/_bun/wasm-dev/instance_1/events" }, html: "<!doctype html><html><head></head><body>hi</body></html>", policy: Array(6).fill(null) };

test("wire parsers accept only bounded committed stamps and same-instance scoped endpoints", () => {
  expect(parseStamp(stamp)).toEqual(stamp);
  expect(parseNotice(JSON.stringify({ kind: "committed", stamp }))).toEqual(stamp);
  expect(parseConfig(config)).toEqual(config);
  for (const value of [null, 1, {}, { server: "other/path", revision: 1 }, { server: "ok", revision: 0 }, { server: "ok", revision: Number.MAX_SAFE_INTEGER + 1 }]) expect(() => parseStamp(value)).toThrow();
  for (const value of [null, "{}", JSON.stringify({ kind: "prepared", stamp }), "x".repeat(1025)]) expect(() => parseNotice(value)).toThrow();
  expect(() => parseConfig({ ...config, paths: { ...config.paths, events: "https://evil.example/events" } })).toThrow();
  expect(() => parseConfig({ ...config, html: "x".repeat(256 * 1024 + 1) })).toThrow();
  expect(() => parseConfig({ ...config, policy: [] })).toThrow();
});

test("bounded raw reader decodes UTF-8 split across wire chunks and releases its lock", async () => {
  const bytes = new TextEncoder().encode("שלום é");
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  expect(await readHtml(new Response(stream, { headers: { "content-type": "text/html; charset=utf-8" } }), new AbortController().signal)).toBe("שלום é");
  expect(stream.locked).toBe(false);
});

test("oversize and invalid UTF-8 reads cancel once without retaining a locked reader", async () => {
  for (const bytes of [new Uint8Array(256 * 1024 + 1), new Uint8Array([0xc0, 0xaf])]) {
    let canceled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { canceled++; } });
    await expect(readHtml(new Response(stream, { headers: { "content-type": "text/html" } }), new AbortController().signal)).rejects.toThrow();
    expect(canceled).toBe(1);
    expect(stream.locked).toBe(false);
  }
});

test("abort while blocked in reader.read cancels and releases the pending reader", async () => {
  let canceled = 0;
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { canceled++; } });
  const pending = readHtml(new Response(stream, { headers: { "content-type": "text/html" } }), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(canceled).toBe(1);
  expect(stream.locked).toBe(false);
});

for (const [name, response] of [
  ["server error", new Response("bad", { status: 500 })],
  ["redirect", new Response(null, { status: 302 })],
  ["JSON", new Response("{}", { headers: { "content-type": "application/json" } })],
  ["legacy charset", new Response("bad", { headers: { "content-type": "text/html; charset=windows-1252" } })],
] satisfies [string, Response][]) {
  test(`${name} cannot become an HTML candidate`, async () => {
    await expect(readHtml(response, new AbortController().signal)).rejects.toThrow();
    expect(response.bodyUsed).toBe(false);
    await response.body?.cancel();
  });
}
