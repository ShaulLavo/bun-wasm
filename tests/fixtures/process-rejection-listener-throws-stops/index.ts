// Errors that 'unhandledRejection' listeners throw and nothing claims are printed, and the rest
// of the rejections are still reported. With no immediate queued the event loop then stops at
// once: the pending timer never runs, 'beforeExit' is skipped, and the process exits 1.
process.on("exit", code => console.log("exit", code, process.exitCode));
process.on("beforeExit", () => console.log("beforeExit"));
process.on("unhandledRejection", reason => {
  console.log("rejection", reason);
  if (reason !== "r2") throw "thrown for " + String(reason);
});
setTimeout(() => console.log("timer"), 200);
Promise.reject("r1");
Promise.reject("r2");
Promise.reject("r3");
