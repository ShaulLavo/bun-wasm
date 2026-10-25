import assert from "node:assert/strict";

const timeout = setTimeout(() => { throw new Error("server signal did not settle"); }, 2000);
let entered = Promise.withResolvers<AbortSignal>();
let finished = Promise.withResolvers<void>();
let events = 0;
const server = Bun.serve({ port: 0, fetch(req) {
  entered.resolve(req.signal);
  return new Promise<Response>(resolve => req.signal.addEventListener("abort", () => {
    events++;
    resolve(new Response("cancelled"));
    finished.resolve();
  }, { once: true }));
} });
try {
  const controller = new AbortController();
  const response = fetch(server.url, { signal: controller.signal }).catch(() => {});
  const signal = await entered.promise;
  controller.abort();
  await response;
  await finished.promise;
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "AbortError");
  assert.equal(events, 1);
  console.log("disconnect aborts active request once");
  entered = Promise.withResolvers<AbortSignal>();
  finished = Promise.withResolvers<void>();
  const second = fetch(server.url).catch(() => {});
  const stopped = await entered.promise;
  await server.stop(true);
  await second;
  await finished.promise;
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.reason.name, "AbortError");
  assert.equal(events, 2);
  // Handler completion is queued before Bun decrements its pending count.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(server.pendingRequests, 0);
  console.log("forced stop aborts active request and releases accounting");
} finally {
  clearTimeout(timeout);
  await server.stop(true);
}
