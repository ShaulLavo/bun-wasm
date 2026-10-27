const original = new Error("native identity");
let handled = 0;
process.on("uncaughtException", error => {
  if (error !== original) throw Error("native report lost object identity");
  Bun.gc(true);
  if (error.message !== "native identity") throw Error("native error lost after GC");
  handled++;
});
__jsc_test_report(original);
if (handled !== 1) throw Error("native error was not synchronously handled");
console.log("native uncaught identity and GC; execution continued");
