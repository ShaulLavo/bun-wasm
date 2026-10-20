import assert from "node:assert/strict";
import net from "node:net";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const started = Promise.withResolvers<void>();
const proceed = Promise.withResolvers<void>();
const cleanup = Promise.withResolvers<void>();
const cancelled = Promise.withResolvers<void>();
const ended = Promise.withResolvers<void>();
const timedOut = Promise.withResolvers<never>();
let cancellations = 0;
let reason: unknown = "unset";
const source = new ReadableStream({
  cancel(value) {
    cancellations++;
    reason = value;
    cancelled.resolve();
    return cleanup.promise;
  },
});
const server = Bun.serve({
  port: 0,
  async fetch() {
    started.resolve();
    await proceed.promise;
    return new Response(source);
  },
});
const socket = net.connect({ host: "127.0.0.1", port: server.port, allowHalfOpen: true });
socket.on("error", () => {});
socket.on("data", () => {});
socket.on("end", () => {
  ended.resolve();
  cleanup.resolve();
});
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await started.promise;
  socket.end();
  await delay(40);
  proceed.resolve();
  deadline = setTimeout(() => timedOut.reject(new Error("early EOF transport waits on producer cleanup; cleanup waits on peer close")), 1000);
  await Promise.race([cancelled.promise, timedOut.promise]);
  assert.equal(cancellations, 1);
  assert.equal(reason, undefined);
  assert.equal(source.locked, false);
  await Promise.race([ended.promise, timedOut.promise]);
  await cleanup.promise;
  assert.equal(cancellations, 1);
  assert.equal(source.locked, false);
  console.log("peer closed without awaiting producer cleanup");
} finally {
  clearTimeout(deadline);
  cleanup.resolve();
  proceed.resolve();
  socket.destroy();
  await server.stop(true);
}
