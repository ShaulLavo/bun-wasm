// Bun's `type: "direct"` streams run their source's pull and cancel in the context they were
// constructed in too. The close() a direct source gets when the stream finishes still runs,
// with the source as `this`.
import { AsyncLocalStorage } from "node:async_hooks";

type DirectController = { write(chunk: string): void; close(): void };
const als = new AsyncLocalStorage<string>();
let stream!: ReadableStream;
als.run("direct", () => {
  stream = new ReadableStream({
    type: "direct",
    pull(controller: DirectController) {
      console.log("pull", als.getStore());
      controller.write("hello");
    },
    cancel() { console.log("cancel", als.getStore()); },
  } as unknown as UnderlyingDefaultSource);
});
const reader = stream.getReader();
await reader.read();
await als.run("canceller", () => reader.cancel());
console.log("after", als.getStore());

const closingSource = {
  type: "direct",
  async pull(controller: DirectController) {
    controller.write("bye");
    controller.close();
  },
  close(reason?: unknown) { console.log("close", reason, this === closingSource); },
};
const closing = als.run("closing", () => new ReadableStream(closingSource as unknown as UnderlyingDefaultSource));
console.log("text", await als.run("reader", () => new Response(closing).text()));
await new Promise(resolve => setTimeout(resolve, 10));

// A direct stream constructed with no store still calls close().
const plain = new ReadableStream({
  type: "direct",
  async pull(controller: DirectController) {
    controller.write("plain");
    controller.close();
  },
  close(reason?: unknown) { console.log("close without a store", reason); },
} as unknown as UnderlyingDefaultSource);
console.log("text", await new Response(plain).text());
await new Promise(resolve => setTimeout(resolve, 10));
