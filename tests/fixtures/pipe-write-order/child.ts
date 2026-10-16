const fd = Number(process.argv[2]);
const stream = fd === 2 ? process.stderr : process.stdout;
const report = fd === 2 ? process.stdout : process.stderr;
const order = [];
let returned = false;
let callbackError;
const properties = error => ({ code: error.code, errno: error.errno, syscall: error.syscall });
stream.once("error", error => {
  order.push("event");
  report.write(JSON.stringify({ order, returned, same: callbackError === error, callback: callbackError && properties(callbackError), event: properties(error) }));
  process.exit(0);
});
function pump() {
  returned = false;
  const writable = stream.write("x".repeat(65536), error => {
    if (!error) return;
    callbackError = error;
    order.push("callback");
    process.nextTick(() => order.push("callback tick"));
  });
  returned = true;
  if (writable) setImmediate(pump);
  else stream.once("drain", pump);
}
pump();
