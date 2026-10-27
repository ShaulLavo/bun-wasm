import assert from "node:assert/strict";

let requests = 0;
const server = Bun.serve({ port: 0, async fetch(req) { requests++; return new Response(await req.arrayBuffer()); } });
const timeout = setTimeout(() => { throw new Error("upload cancellation did not settle"); }, 2000);

async function openUpload(reason: unknown): Promise<void> {
  const controller = new AbortController();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(value) { source = value; value.enqueue(new Uint8Array([42])); } });
  const result = fetch(server.url, { method: "POST", body, signal: controller.signal });
  await Promise.resolve();
  controller.abort(reason);
  await assert.rejects(result, error => Object.is(error, reason));
  // Native fetch can keep the upload producer open after abort; finish its local source.
  if (!body.locked) await body.cancel();
  else { try { source?.close(); } catch {} }
}

try {
  for (const reason of [null, false, 0, "", "cancelled", new Error("cancelled")]) await openUpload(reason);
  console.log("open uploads preserve abort reasons");
  const before = new AbortController();
  before.abort("before");
  await assert.rejects(fetch(server.url, { method: "POST", body: "unused", signal: before.signal }), error => error === "before");
  console.log("already aborted upload rejects");
  const body = new ReadableStream({ start(source) { source.enqueue(new Uint8Array([1, 2])); source.enqueue(new Uint8Array([3])); source.close(); } });
  const response = await fetch(server.url, { method: "POST", body });
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2, 3]);
  console.log("finite upload preserves bytes");
  assert.equal(requests, 1);
  console.log("cancelled uploads never dispatch");
} finally {
  clearTimeout(timeout);
  await server.stop(true);
}
