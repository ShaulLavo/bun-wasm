// Callbacks queued from an immediate show only the program's own frames, as in Bun. On the
// Browser engine's Node test host, Node runs the host microtask that drains them through
// AsyncResource.runInAsyncScope (node:async_hooks), a host frame no stack may show. Bun's own
// processTicksAndRejections frame is left out here; stack-tick-frame covers it. The callbacks
// are named, so the frames do not depend on how each engine names an anonymous function.
function frames(error: Error): string[] {
  return error.stack!.split("\n").slice(1).map(line => line.trim()).filter(line => !line.includes("processTicksAndRejections"));
}

setImmediate(function fromImmediate() {
  process.nextTick(function tick() {
    console.log("tick", frames(new Error("tick")));
  });
  queueMicrotask(function microtask() {
    console.log("microtask", frames(new Error("microtask")));
  });
  Promise.resolve().then(function reaction() {
    console.log("reaction", frames(new Error("reaction")));
  });
  process.nextTick(function outer() {
    process.nextTick(function nested() {
      console.log("nested tick", frames(new Error("nested")));
    });
  });
});
