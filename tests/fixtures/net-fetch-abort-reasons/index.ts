import assert from "node:assert/strict";

const encoder = new TextEncoder();
const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(new ReadableStream({ start(source) { source.enqueue(encoder.encode("open")); } }));
  },
});

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
  await check("null", null);
  await check("zero", 0);
  await check("false", false);
  await check("string", "stopped");
  await check("error", new Error("stopped"));
} finally {
  server.stop(true);
}
