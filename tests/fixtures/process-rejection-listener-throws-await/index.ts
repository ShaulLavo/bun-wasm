// While the entry module still awaits, an error an 'unhandledRejection' listener threw and nothing
// claimed does not stop the event loop: the module runs to its end and later rejections are still
// reported. Once it settles the loop stops (the later timer never runs), without 'beforeExit'.
// An exit code set before the throw reads 1 from then on, as Bun's does, and the process exits 1.
process.on("exit", code => console.log("exit", code, process.exitCode));
process.on("beforeExit", () => console.log("beforeExit"));
process.exitCode = 3;
process.on("unhandledRejection", reason => {
  console.log("rejection", reason, "exitCode", process.exitCode);
  throw new Error("from " + String(reason));
});
Promise.reject("r1");
await Bun.sleep(20);
console.log("after sleep", process.exitCode);
Promise.reject("r2");
await new Promise(resolve => setTimeout(resolve, 30));
console.log("after second sleep");
setTimeout(() => console.log("timer after the module settled"), 30);
