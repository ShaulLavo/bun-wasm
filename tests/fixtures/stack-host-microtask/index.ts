// Callbacks queued from an immediate show only the program's own frames, as in Bun. On the
// Browser engine's Node test host, Node runs the host microtask that drains them through
// AsyncResource.runInAsyncScope (node:async_hooks), a host frame no stack may show. Bun's own
// processTicksAndRejections frame is left out here; stack-tick-frame covers it.
function frames(error: Error): string[] {
  return error.stack!.split("\n").slice(1).map(line => line.trim()).filter(line => !line.includes("processTicksAndRejections"));
}

setImmediate(function fromImmediate() {
  process.nextTick(() => console.log("tick", frames(new Error("tick"))));
  queueMicrotask(() => console.log("microtask", frames(new Error("microtask"))));
  Promise.resolve().then(() => console.log("reaction", frames(new Error("reaction"))));
  process.nextTick(() => {
    process.nextTick(() => console.log("nested tick", frames(new Error("nested"))));
  });
});
