process.once("uncaughtException", value => {
  if (value !== 42 || typeof value !== "number") throw Error("encoded primitive was not decoded");
  Bun.gc(true);
  console.log("native primitive identity and GC");
});
__jsc_test_report(42);
process.on("exit", code => {
  if (code !== 1) throw Error("native primitive did not take fatal exit");
  console.log("native primitive fatal exit 1");
});
__jsc_test_report(42);
console.log("forbidden native fatal continuation");
