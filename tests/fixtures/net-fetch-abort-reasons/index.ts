import assert from "node:assert/strict";

const encoder = new TextEncoder();
let requested = Promise.withResolvers<void>();
const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/headers") {
      requested.resolve();
      return new Promise<Response>(() => {});
    }
    return new Response(new ReadableStream({ start(source) { source.enqueue(encoder.encode("open")); } }));
  },
});

async function checkHeaders(label: string, reason: unknown): Promise<void> {
  requested = Promise.withResolvers<void>();
  const controller = new AbortController();
  const response = fetch(new URL("headers", server.url), { signal: controller.signal });
  await requested.promise;
  controller.abort(reason);
  await assert.rejects(response, error => Object.is(error, reason));
  console.log("headers abort", label, "identity");
}

async function check(label: string, reason: unknown): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(server.url, { signal: controller.signal });
  const body = response.text();
  controller.abort(reason);
  let rejected = false;
  try { await body; }
  catch (error) { rejected = true; assert.equal(error, reason); }
  assert.equal(rejected, true);
  console.log("body abort", label, "identity");
}

try {
  await checkHeaders("empty", "");
  await checkHeaders("null", null);
  await checkHeaders("zero", 0);
  await checkHeaders("false", false);
  await checkHeaders("string", "stopped");
  await checkHeaders("error", new Error("stopped"));
  await check("empty", "");
  await check("null", null);
  await check("zero", 0);
  await check("false", false);
  await check("string", "stopped");
  await check("error", new Error("stopped"));
} finally {
  server.stop(true);
}
