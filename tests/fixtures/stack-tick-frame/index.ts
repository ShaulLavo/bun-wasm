// A process.nextTick callback runs inside Bun's processTicksAndRejections, and error.stack
// shows that frame as `processTicksAndRejections (native:7:39)`. Code that runs outside the
// tick pass, including a promise reaction after the tick queue went idle, does not show it.
const root = import.meta.dir;
const prefix = root.endsWith("/") ? root : `${root}/`;
const frames = (error: Error) => String(error.stack).split(prefix).join("./").split("\n").slice(1).map(line => line.trim()).join(" | ");
const inTicks = (error: Error) => String(error.stack).includes("processTicksAndRejections");

await new Promise<void>(resolve => process.nextTick(() => {
  console.log("tick:", frames(new Error("tick")));
  resolve();
}));

await new Promise<void>(resolve => process.nextTick(function named() {
  console.log("named tick:", frames(new Error("named")));
  process.nextTick(() => {
    console.log("nested tick:", frames(new Error("nested")));
    resolve();
  });
}));

// The Browser fixture host's own async_hooks frame can follow here, so only the tick frame is checked.
await new Promise<void>(resolve => setImmediate(() => {
  process.nextTick(() => {
    console.log("tick from an immediate:", inTicks(new Error("immediate tick")));
    resolve();
  });
}));

await new Promise<void>(resolve => process.nextTick((a: number, b: string) => {
  console.log("tick arguments:", a, b, inTicks(new Error("args")));
  resolve();
}, 1, "two"));

// The upstream check: a tick sees the frame, a later reaction does not.
await new Promise<void>(resolve => process.nextTick(() => {
  const tick = inTicks(new Error("tick"));
  setImmediate(() => {
    Promise.resolve().then(() => {
      console.log("idle reaction:", JSON.stringify({ tick, reaction: inTicks(new Error("reaction")) }));
      resolve();
    });
  });
}));

await new Promise<void>(resolve => setTimeout(() => {
  console.log("timer:", inTicks(new Error("timer")));
  resolve();
}, 1));

await new Promise<void>(resolve => queueMicrotask(() => {
  console.log("microtask:", inTicks(new Error("microtask")));
  resolve();
}));

// A tick that throws: the uncaught error's stack names the tick pass too.
process.once("uncaughtException", error => {
  console.log("uncaught:", (error as Error).message, inTicks(error as Error));
});
process.nextTick(() => {
  throw new Error("thrown in a tick");
});
await new Promise(resolve => setTimeout(resolve, 5));

// A user function that happens to share the name is an ordinary frame.
function processTicksAndRejections() {
  return frames(new Error("user"));
}
console.log("user function:", processTicksAndRejections());
