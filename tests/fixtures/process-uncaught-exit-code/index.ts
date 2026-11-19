// An unhandled throw skips 'beforeExit' and exits 1, and an 'exit' listener can change that code.
process.on("beforeExit", () => console.log("beforeExit"));
process.on("exit", code => {
  console.log("exit", code, process.exitCode);
  process.exitCode = 98;
});
throw new Error("ok");
