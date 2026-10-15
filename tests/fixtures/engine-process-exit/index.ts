// process.exit with a code, the "exit" event, and process.exitCode.
process.on("exit", (code) => console.log("exit event", code));
console.log("start");
setTimeout(() => console.log("never"), 100);
Promise.resolve().then(() => {
  console.log("microtask");
  process.exit(3);
});
