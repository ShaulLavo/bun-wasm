globalThis.order = [];
globalThis.sharedRuns = 0;

async function main() {
  const lowered = new Function("s", "return import(s)");
  const pending = lowered("./p.mts");
  Promise.resolve().then(() => order.push("promise-before"));
  queueMicrotask(() => order.push("microtask-before"));
  order.push("before-require");
  const required = require("./r.mts");
  order.push("after-require");
  console.log("sync", order.join(","));
  await pending;
  console.log("settled", order.join(","));
  console.log("d runs", sharedRuns);
  console.log("identity", required === await import("./r.mts"));
}

main().catch(error => { throw error; });
