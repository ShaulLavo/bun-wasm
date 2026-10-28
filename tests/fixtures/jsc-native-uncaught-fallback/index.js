process.on("uncaughtException", () => { throw "native-handler-fallback"; });
__jsc_test_report(new Error("native original"));
console.log("forbidden native handler-error continuation");
