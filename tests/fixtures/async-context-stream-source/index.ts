// A ReadableStream's source runs in the async context the stream was constructed in, as Bun's
// StreamAsyncContextScope does: start, pull and cancel see that store, whoever calls them. The
// loop's own 'exit' runs outside every context, so a top-level enterWith() does not reach it.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();
const seen: string[] = [];
process.on("exit", () => {
  seen.push("exit:" + als.getStore());
  console.log(seen.toSorted().join("\n"));
});

let stream!: ReadableStream<string>;
als.run("constructed", () => {
  stream = new ReadableStream<string>({
    start() { seen.push("start:" + als.getStore()); },
    pull(controller) {
      seen.push("pull:" + als.getStore());
      controller.enqueue("x");
    },
    cancel() { seen.push("cancel:" + als.getStore()); },
  });
});
(async () => {
  const reader = stream.getReader();
  await reader.read();
  await als.run("canceller", () => reader.cancel());
  seen.push("after:" + als.getStore());
})();

als.enterWith("top");
setTimeout(() => seen.push("timer-after-top:" + als.getStore()));
