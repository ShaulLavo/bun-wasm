import { text, blob } from "node:stream/consumers";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function readerOnly<T>(source: UnderlyingDefaultSource<T>) {
  const stream = new ReadableStream<T>(source, { highWaterMark: 0 });
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
  Object.defineProperty(stream, "values", { value: undefined });
  return stream;
}
const encode = (text: string) => new TextEncoder().encode(text);
const stream = readerOnly({ start(c) { c.enqueue(encode('{"value":')); c.enqueue(encode('"ssr"}')); c.close(); } });
const response = new Response(stream);
assert(!response.bodyUsed, "body used before read");
assert((await response.json()).value === "ssr", "response data");
assert(response.bodyUsed && !stream.locked, "response cleanup");
console.log("response data and bodyUsed");
const request = new Request("http://localhost/", { method: "POST", body: readerOnly({ start(c) { c.enqueue(encode("request")); c.close(); } }) });
assert(await request.text() === "request", "request data");
console.log("request data");
for (const reason of [undefined, null, { marker: "read" }]) {
  let cancelled = false;
  const stream = readerOnly({ pull(c) { c.error(reason); }, cancel() { cancelled = true; } });
  const response = new Response(stream);
  const result = await response.text().then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
  assert(!result.ok && result.error === reason, "read rejection identity");
  assert(response.bodyUsed && !stream.locked && !cancelled, "read cleanup");
}
console.log("read errors retain identity and release locks");
let cancellations = 0;
const invalid = readerOnly<unknown>({ pull(c) { c.enqueue({ invalid: true }); }, cancel() { cancellations++; throw new Error("cancel"); } });
try { await new Response(invalid).text(); throw new Error("invalid chunk accepted"); }
catch (error) { assert(error instanceof TypeError, "conversion error masked"); }
assert(cancellations === 1 && !invalid.locked, "cancel cleanup");
console.log("conversion errors cancel and release locks");
async function* chunks() { yield encode("generic"); }
assert(await new Response(chunks()).text() === "generic", "async iterable changed");
console.log("generic async iterable body");

assert(await text(readerOnly({ start(c) { c.enqueue(encode("text")); c.close(); } })) === "text", "consumer text");
assert(await (await blob(readerOnly({ start(c) { c.enqueue(encode("blob")); c.close(); } }))).text() === "blob", "consumer blob");
console.log("reader-only stream consumers");
assert(await text(["sync", encode(" iterable")]) === "sync iterable", "sync iterable changed");
assert(await text(chunks()) === "generic", "async consumer changed");
console.log("generic stream consumers");
const cancelStarted = Promise.withResolvers<void>();
const cancelFinished = Promise.withResolvers<void>();
const pending = readerOnly<unknown>({ pull(c) { c.enqueue({ invalid: true }); }, cancel() { cancelStarted.resolve(); return cancelFinished.promise; } });
let observed = false;
const failed = new Response(pending).text().then(
  () => { throw new Error("invalid chunk accepted"); },
  error => { observed = true; return { error, locked: pending.locked }; },
);
await cancelStarted.promise;
assert(!observed && pending.locked, "consumer rejected before cancellation settled");
cancelFinished.reject(null);
const failure = await failed;
assert(failure.error instanceof TypeError && !failure.locked, "consumer error or final lock state changed");
console.log("cancellation settles before original rejection and lock release");
