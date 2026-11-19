// Ticks and microtasks that 'unhandledRejection' listeners queue run once that pass of reports
// ends, before the next immediate or timer; a rejection they make is reported right after them.
const log = (...values: unknown[]) => console.log(...values);
process.on("uncaughtException", err => log("uncaught", err.message));
process.on("unhandledRejection", reason => {
  log("rejection", reason);
  process.nextTick(() => log("tick", reason));
  Promise.resolve().then(() => {
    log("micro", reason);
    if (reason === "r2") Promise.reject("from micro");
  });
  if (reason === "r1") throw new Error("thrown for r1");
});
setTimeout(() => log("timer"), 0);
setImmediate(() => log("immediate"));
Promise.reject("r1");
Promise.reject("r2");
log("sync end");
