// A throw inside the uncaughtException handler is fatal: exit code 7, with 'exit' listeners.
process.on("exit", code => console.log("exit", code, process.exitCode));
process.on("uncaughtException", () => {
  console.log("handler");
  throw new Error("bar");
});
throw new Error("foo");
