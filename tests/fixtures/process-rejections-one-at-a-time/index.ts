// Unhandled rejections are reported one at a time, in rejection order, re-checking each before
// its report: a listener that handles a later rejection keeps it from being reported (and owes
// it no 'rejectionHandled'), and a rejection made inside a listener is reported in the same turn.
const turn = () => new Promise(resolve => setImmediate(resolve));
const handledLate: string[] = [];
process.on("rejectionHandled", promise => handledLate.push(String(promises.get(promise))));
const promises = new Map<Promise<unknown>, unknown>();
const reject = (reason: unknown) => {
  const promise = Promise.reject(reason);
  promises.set(promise, reason);
  return promise;
};

const seen: unknown[] = [];
let nestedTurn = -1;
let listenerCalls = 0;
process.on("unhandledRejection", reason => {
  listenerCalls++;
  if (reason === "nested") {
    nestedTurn = listenerCalls;
    return;
  }
  seen.push(reason);
  if (reason === 0) reject("nested");
});
for (let i = 0; i < 1000; i++) reject(i);
reject("handled").catch(() => {});
await turn();
await turn();
const inOrder = seen.every((reason, i) => reason === i);
console.log("reported", seen.length, "in order", inOrder, "nested reported as call", nestedTurn);

// The first listener call handles every odd rejection after it, and the fifth one handles a
// rejection it already saw reported: that one alone gets 'rejectionHandled'.
process.removeAllListeners("unhandledRejection");
const batch: Promise<unknown>[] = [];
const batchSeen: unknown[] = [];
process.on("unhandledRejection", reason => {
  batchSeen.push(reason);
  if (reason === "b0") for (let i = 1; i < 20; i += 2) batch[i].catch(() => {});
  if (reason === "b8") batch[2].catch(() => {});
});
for (let i = 0; i < 20; i++) batch.push(reject("b" + i));
await turn();
await turn();
console.log("batch", batchSeen.join(" "));
console.log("rejectionHandled", handledLate.join(" ") || "none");

// A listener that handles the next pending rejection: neither event for it.
process.removeAllListeners("unhandledRejection");
let late: Promise<unknown>;
const lateSeen: unknown[] = [];
process.on("unhandledRejection", reason => {
  lateSeen.push(reason);
  if (reason === "early") late.catch(() => {});
});
reject("early");
late = reject("late");
await turn();
await turn();
console.log("early and late", lateSeen.join(" "), "rejectionHandled", handledLate.join(" ") || "none");
