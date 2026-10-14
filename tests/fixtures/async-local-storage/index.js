const { AsyncLocalStorage, AsyncResource } = require("node:async_hooks");
const als = new AsyncLocalStorage();
const other = new AsyncLocalStorage();
const log = (label) => console.log(label, JSON.stringify(als.getStore()), JSON.stringify(other.getStore()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(id) {
  log(`start ${id}`);
  await sleep(5 * id);
  log(`after sleep ${id}`);
  await Promise.resolve();
  other.run({ inner: id }, () => log(`nested ${id}`));
  await null;
  log(`end ${id}`);
}

log("outside");
const done = [
  als.run({ id: 1 }, () => handle(1)),
  als.run({ id: 2 }, () => handle(2)),
];
als.run("timer", () => setTimeout(() => log("in timer"), 1));
als.run("tick", () => process.nextTick(() => log("in tick")));
als.run("immediate", () => setImmediate(() => log("in immediate")));
als.run("then", () => Promise.resolve().then(() => log("in then")));
const resource = als.run("resource", () => new AsyncResource("demo"));
const bound = als.run("bound", () => AsyncLocalStorage.bind(() => log("bound fn")));
Promise.all(done).then(() => {
  log("after all");
  resource.runInAsyncScope(() => log("resource scope"));
  bound();
  als.run("exit-test", () => als.exit(() => log("inside exit")));
});
