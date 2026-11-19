// A throw from an 'unhandledRejection' listener is an uncaught exception: an 'uncaughtException'
// listener gets it (origin 'uncaughtException') and the remaining rejections are still reported.
// With no handler to claim it, the error is printed and reporting still goes on. A queued
// immediate keeps the loop alive for one more iteration, which also waits for the next timer;
// then the loop stops without 'beforeExit' and the process exits 1.
process.on("exit", code => console.log("exit", code, process.exitCode));
process.on("beforeExit", () => console.log("beforeExit"));
const turn = () => new Promise(resolve => setImmediate(resolve));

process.on("uncaughtException", (err, origin) => console.log("uncaught", err.message, origin));
process.on("unhandledRejection", reason => {
  console.log("rejection", reason);
  if (reason === "b1") {
    setImmediate(() => console.log("immediate queued by a listener"));
    setTimeout(() => console.log("timer set by a listener"), 50);
    setTimeout(() => console.log("second timer, never run"), 400);
  }
  throw new Error("from " + String(reason));
});
Promise.reject("a1");
Promise.reject("a2");
Promise.reject("a3");
await turn();
await turn();
console.log("still running");

process.removeAllListeners("uncaughtException");
Promise.reject("b1");
Promise.reject("b2");
