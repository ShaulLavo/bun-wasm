// An 'unhandledRejection' listener that handles its own promise and rejects a new one: the new
// rejection is reported in the same pass, before the 'rejectionHandled' the first one is owed.
// Node, the Browser engine's test host, emits these in another order, so this runs on QuickJS
// and JSC only.
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
const order: string[] = [];
let own: Promise<unknown> | undefined;
process.on("unhandledRejection", reason => {
  order.push("unhandledRejection " + String(reason));
  if (reason !== "own") return;
  own!.catch(() => {});
  Promise.reject("after-own");
});
process.on("rejectionHandled", promise => order.push("rejectionHandled " + (promise === own ? "own" : "other")));
own = Promise.reject("own");
await drain();
console.log(order.join(", "));
