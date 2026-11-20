// The uncaught exception capture callback: argument checks, has/set, the monitor before it,
// process._fatalException's result and origin, and a throw from a timer that it captures.
const report = (error: Error & { code?: string }) => console.log(error.name, error.code, error.message);
console.log("has", process.hasUncaughtExceptionCaptureCallback());
try { process.setUncaughtExceptionCaptureCallback(1 as never); } catch (error) { report(error); }
const fatal = (process as unknown as { _fatalException(error: Error, fromPromise?: boolean): boolean })._fatalException;
console.log("unclaimed", fatal(new Error("nobody listening")));
process.on("uncaughtExceptionMonitor", (error, origin) => console.log("monitor", error.message, origin));
process.setUncaughtExceptionCaptureCallback((error: Error, origin?: string) => console.log("captured", error.message, origin));
console.log("has", process.hasUncaughtExceptionCaptureCallback());
try { process.setUncaughtExceptionCaptureCallback(() => {}); } catch (error) { report(error); }
console.log("claimed", fatal(new Error("from promise"), true));
setTimeout(() => {
  throw new Error("from timer");
}, 1);
setTimeout(() => {
  process.setUncaughtExceptionCaptureCallback(null);
  console.log("has", process.hasUncaughtExceptionCaptureCallback());
  process.setUncaughtExceptionCaptureCallback(() => {});
  console.log("has", process.hasUncaughtExceptionCaptureCallback());
}, 20);
