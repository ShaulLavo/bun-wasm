// beforeExit: a throw inside reaches the uncaught handlers, timer work brings a second
// 'beforeExit', the microtasks and ticks a listener queues run before 'exit' without a
// third one, and a throw from an 'exit' listener reaches the uncaught handlers too.
process.on("uncaughtExceptionMonitor", (error, origin) => console.log("monitor", error.message, origin));
process.on("uncaughtException", (error, origin) => console.log("uncaughtException", error.message, origin));
let round = 0;
process.on("beforeExit", code => {
  round++;
  console.log("beforeExit", round, code, process.exitCode);
  if (round === 1) {
    setTimeout(() => console.log("timer"), 1);
    throw new Error("boom");
  }
  if (round === 2) {
    Promise.resolve().then(() => {
      console.log("microtask");
      process.nextTick(() => console.log("tick"));
    });
  }
});
process.on("exit", code => {
  console.log("exit", code, process.exitCode);
  throw new Error("from exit");
});
console.log("main");
