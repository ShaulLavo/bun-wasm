// An unhandled throw from 'beforeExit' is fatal: exit 1, and a throw from an 'exit'
// listener on the way out does not turn that into 7.
process.on("beforeExit", () => {
  throw new Error("a");
});
process.on("exit", code => console.log("exit", code, process.exitCode));
process.on("exit", () => {
  throw new Error("b");
});
