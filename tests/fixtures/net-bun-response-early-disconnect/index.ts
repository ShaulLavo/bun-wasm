import assert from "node:assert/strict";
import net from "node:net";

const encoder = new TextEncoder();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type DisconnectMode = "end" | "destroy";

async function probe(mode: DisconnectMode): Promise<void> {
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let cancellations = 0;
  let cancelReason: unknown = "unset";
  const cancelled = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("open")); },
    cancel(reason) {
      cancellations++;
      cancelReason = reason;
      cancelled.resolve();
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
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
        resolve();
      });
    });
    await started.promise;
    const disconnect = mode === "end" ? () => socket.end() : () => socket.destroy();
    disconnect();
    await delay(40);
    proceed.resolve();
    await Promise.race([
      cancelled.promise,
      delay(1000).then(() => { throw new Error(`${mode} disconnect did not cancel response`); }),
    ]);
    assert.equal(cancelReason, undefined);
    assert.equal(cancellations, 1);
    assert.equal(source.locked, false);
    console.log("early", mode, "cancelled once");
  } finally {
    socket.destroy();
    await server.stop(true);
  }
}

await probe("end");
await probe("destroy");
