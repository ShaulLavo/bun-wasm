import assert from "node:assert/strict";
import net from "node:net";

const encoder = new TextEncoder();
async function disconnect(port: number): Promise<void> {
  const socket = net.connect(port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"));
      socket.once("data", () => { socket.destroy(); resolve(); });
    });
  } finally { socket.destroy(); }
}

async function check(iterator: boolean): Promise<void> {
  const cancelled = Promise.withResolvers<unknown>();
  let calls = 0;
  let cancellations = 0;
  const source = iterator ? ReadableStream.from({
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (calls++ === 0) return Promise.resolve({ done: false, value: encoder.encode("open") });
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        return(reason: unknown) { cancellations++; cancelled.resolve(reason); return Promise.resolve({ done: true, value: undefined }); },
      };
    },
  }) : new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("open")); },
    cancel(reason) { cancellations++; cancelled.resolve(reason); },
  });
  const server = Bun.serve({ port: 0, fetch() { return new Response(source); } });
  const deadline = setTimeout(() => cancelled.reject(new Error("disconnect did not cancel response")), 1000);
  try {
    await disconnect(server.port);
    assert.equal(await cancelled.promise, undefined);
    assert.equal(cancellations, 1);
    console.log("disconnect", iterator ? "iterator" : "stream", "cancelled once");
  } finally { clearTimeout(deadline); server.stop(true); }
}

async function locked(): Promise<void> {
  let cancellations = 0;
  const source = new ReadableStream({ cancel() { cancellations++; } });
  const reader = source.getReader();
  const server = Bun.serve({
    port: 0,
    fetch() { return new Response(source); },
    error() { return new Response("locked"); },
  });
  try {
    assert.equal(await (await fetch(server.url)).text(), "locked");
    assert.equal(source.locked, true);
    assert.equal(cancellations, 0);
    console.log("locked reader retained");
  } finally { server.stop(true); reader.releaseLock(); await source.cancel(); }
}

await check(false);
await check(true);
await locked();
