// A timer handles a promise reported earlier and rejects another: 'rejectionHandled' for the
// first comes before the second's report, as in Bun and Node. (The timer is set from the
// module's synchronous code: after a top-level await native Bun 1.4.4 reports the second
// first, while Node keeps this order.)
const log: string[] = [];
process.on("unhandledRejection", reason => log.push("unhandledRejection " + String(reason)));
process.on("rejectionHandled", promise => log.push("rejectionHandled " + (promise === first ? "first" : "other")));
const first = Promise.reject("first");
setTimeout(() => {
  first.catch(() => {});
  Promise.reject("second");
}, 10);
setTimeout(() => console.log(log.join(", ")), 50);
