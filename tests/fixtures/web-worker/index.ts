import assert from "node:assert/strict";

function closed(worker: Worker) {
  return new Promise<Event>(resolve => worker.addEventListener("close", resolve, { once: true }));
}
function message(worker: Worker) {
  return new Promise<unknown>((resolve, reject) => {
    worker.addEventListener("message", event => resolve(event.data), { once: true });
    worker.addEventListener("error", reject, { once: true });
  });
}

const initialData = { value: 17 };
const worker = new Worker(new URL("./worker.ts", import.meta.url), { name: "echo", argv: ["arg"], env: { WORKER_ONLY: "yes" }, type: "module", smol: true, data: initialData });
initialData.value = 99;
assert.ok(worker instanceof EventTarget);
assert.ok(worker.threadId > 0);
const order: string[] = [];
worker.addEventListener("open", () => order.push("open"), { once: true });
worker.addEventListener("message", event => {
  order.push("message");
  assert.ok(event instanceof MessageEvent);
  assert.equal(event.target, worker);
});
const result = message(worker);
const data = new Uint8Array([42]);
worker.postMessage({ data }, [data.buffer]);
assert.equal(data.byteLength, 0);
assert.deepEqual(await result, { byte: 42, main: false, arg: "arg", env: "yes", same: true, entry: false, initial: 17 });
const close = closed(worker);
worker.terminate();
worker.postMessage(() => {});
worker.terminate();
await close;
worker.ref(); worker.unref(); worker.terminate();
assert.deepEqual(order, ["open", "message"]);
assert.equal(Bun.isMainThread, true);
console.log("file worker, globals, options, transfer, events, terminate");

const natural = new Worker("data:text/javascript,postMessage(1);postMessage(2)");
const seen: unknown[] = [];
natural.onmessage = event => seen.push(event.data);
await closed(natural);
assert.deepEqual(seen, [1, 2]);
console.log("messages drain before natural close");

const failing = new Worker("data:text/javascript,throw new Error('worker failure')");
const failed = new Promise<ErrorEvent>(resolve => { failing.onerror = resolve; });
const failureClose = closed(failing);
assert.ok((await failed).message.includes("worker failure"));
await failureClose;
const missing = new Worker("./missing-worker.ts");
const missingOrder: string[] = [];
missing.addEventListener("open", () => missingOrder.push("open"));
missing.onerror = () => missingOrder.push("error");
await closed(missing);
assert.deepEqual(missingOrder, ["open", "error"]);
console.log("worker errors, missing entry, open before error");

const scope = new Worker("data:text/javascript," + encodeURIComponent(`
  const handler = function(event) { postMessage(event.data); };
  const options = { once: true, capture: false };
  addEventListener('message', handler, options);
  options.once = false;
  options.capture = true;
`));
const scopeResult = message(scope);
const scopeClose = closed(scope);
scope.postMessage("listener");
assert.equal(await scopeResult, "listener");
await scopeClose;
const undefinedWorker = new Worker("data:text/javascript,onmessage=e=>{postMessage(e.data);close()}");
const undefinedResult = message(undefinedWorker);
const undefinedClose = closed(undefinedWorker);
undefinedWorker.postMessage(undefined);
assert.equal(await undefinedResult, undefined);
await undefinedClose;
const portOnly = new Worker("data:text/javascript," + encodeURIComponent(`
  const { parentPort } = require('node:worker_threads');
  parentPort.once('message', value => parentPort.postMessage(value));
`));
const portOnlyResult = message(portOnly);
const portOnlyClose = closed(portOnly);
portOnly.postMessage("parentPort");
assert.equal(await portOnlyResult, "parentPort");
await portOnlyClose;
console.log("worker global event listeners and close");

const preloaded = new Worker(new URL("./preload-entry.ts", import.meta.url), { preload: new URL("./preload.ts", import.meta.url).href });
const preloadClose = closed(preloaded);
assert.deepEqual(await message(preloaded), { value: 23, entry: false });
await preloadClose;
const badPreload = new Worker("data:text/javascript,postMessage('should not run')", { preload: "./missing-preload.ts" });
const badPreloadClose = closed(badPreload);
const preloadError = await new Promise<ErrorEvent>(resolve => { badPreload.onerror = resolve; });
assert.ok(preloadError.message.includes("missing-preload"));
await badPreloadClose;
console.log("worker preload");

const blobUrl = URL.createObjectURL(new File(["const value: number = 7; postMessage(value);"], "worker.ts"));
const blob = new Worker(blobUrl);
const blobClose = closed(blob);
assert.equal(await message(blob), 7);
URL.revokeObjectURL(blobUrl);
await blobClose;
console.log("TypeScript blob worker");

const nested = new Worker("data:text/javascript," + encodeURIComponent(`
  const child = new Worker('data:text/javascript,postMessage(Bun.isMainThread)');
  child.onmessage = event => postMessage(event.data);
`));
const nestedClose = closed(nested);
assert.equal(await message(nested), false);
await nestedClose;
console.log("nested web worker");

const unreferenced = Bun.spawn([process.execPath, "-e", "new Worker('data:text/javascript,setInterval(()=>{},100000)', {ref:false});console.log('unreferenced')"], { stdout: "pipe", stderr: "pipe" });
const [unreferencedOutput, unreferencedError, unreferencedCode] = await Promise.all([new Response(unreferenced.stdout).text(), new Response(unreferenced.stderr).text(), unreferenced.exited]);
assert.equal(unreferencedOutput, "unreferenced\n");
assert.equal(unreferencedError, "");
assert.equal(unreferencedCode, 0);
console.log("unreferenced worker releases parent");

const channel = new MessageChannel();
const portWorker = new Worker("data:text/javascript," + encodeURIComponent(`
  onmessage = event => {
    const port = event.ports[0];
    port.postMessage(event.data);
    postMessage('returned', [port]);
    close();
  };
`));
const portWorkerClose = closed(portWorker);
const returnedPort = new Promise<MessageEvent>(resolve => portWorker.addEventListener("message", resolve, { once: true }));
const firstPortMessage = new Promise<unknown>(resolve => { channel.port1.onmessage = event => resolve(event.data); });
portWorker.postMessage("through transfer", { transfer: [channel.port2] });
assert.equal(await firstPortMessage, "through transfer");
const returnedEvent = await returnedPort;
assert.equal(returnedEvent.data, "returned");
assert.equal(returnedEvent.ports.length, 1);
await portWorkerClose;
const secondPortMessage = new Promise<unknown>(resolve => { channel.port1.onmessage = event => resolve(event.data); });
returnedEvent.ports[0].postMessage("round trip");
assert.equal(await secondPortMessage, "round trip");
returnedEvent.ports[0].close();
channel.port1.close();
console.log("message event ports survive worker exit");

const preloadGate = new BroadcastChannel("web-worker-preload");
const gated = new Worker(new URL("./echo.ts", import.meta.url), { preload: new URL("./gated-preload.ts", import.meta.url).href });
const gatedClose = closed(gated);
assert.equal(await message(gated), "preload ready");
const queued = message(gated);
gated.postMessage("queued during preload");
preloadGate.postMessage("continue");
assert.equal(await queued, "queued during preload");
preloadGate.close();
await gatedClose;
console.log("messages wait for asynchronous preload");

for (const entry of ["data:text/javascript,onmessage=e=>{postMessage(e.data);close()}", URL.createObjectURL(new Blob(["onmessage=e=>{postMessage(e.data);close()}"], { type: "application/javascript" }))]) {
  const gate = new BroadcastChannel("web-worker-preload");
  const child = new Worker(entry, { preload: new URL("./gated-preload.ts", import.meta.url).href });
  const childClose = closed(child);
  assert.equal(await message(child), "preload ready");
  const reply = message(child);
  child.postMessage("queued for eval worker");
  gate.postMessage("continue");
  assert.equal(await reply, "queued for eval worker");
  gate.close();
  await childClose;
  URL.revokeObjectURL(entry);
}
console.log("data and blob workers resume messages after preload");
