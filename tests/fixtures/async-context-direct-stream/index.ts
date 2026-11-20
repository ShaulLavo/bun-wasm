// Bun's `type: "direct"` streams run their source in the context they were constructed in too.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();
let stream!: ReadableStream;
als.run("direct", () => {
  stream = new ReadableStream({
    type: "direct",
    pull(controller: { write(chunk: string): void }) {
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
