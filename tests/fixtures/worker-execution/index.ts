import assert from "node:assert/strict";
import { Worker, MessageChannel, receiveMessageOnPort, SHARE_ENV, setEnvironmentData } from "node:worker_threads";

function exit(worker: Worker): Promise<number> {
  return new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
}
function message(worker: Worker): Promise<any> {
  return new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
}

assert.throws(() => new Worker("file:///worker.ts"), /Wrap file:\/\/ URLs with `new URL`/);
const missingTransfer = new MessageChannel();
assert.throws(() => new Worker("", { eval: true, workerData: missingTransfer.port1 }), {
  name: "DataCloneError", message: "Object that needs transfer was found in message but not listed in transferList",
});
missingTransfer.port1.close(); missingTransfer.port2.close();

setEnvironmentData("inherited", { value: 1 });
const buffer = new ArrayBuffer(4);
new Uint8Array(buffer)[0] = 42;
const cycle: any = { buffer, map: new Map([["key", new Set([1, 2])]]) };
cycle.self = cycle;
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  workerData: cycle, transferList: [buffer], argv: ["arg", 2], env: { ...process.env, WORKER_ONLY: "yes" },
  stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 128 },
});
assert.equal(buffer.byteLength, 0);
let online = false;
worker.once("online", () => { online = true; worker.postMessage("start"); });
let stdout = "", stderr = "";
worker.stdout.on("data", value => { stdout += value; });
worker.stderr.on("data", value => { stderr += value; });
const result = await message(worker);
assert.equal(online, true);
assert.equal(result.isMainThread, false);
assert.ok(result.threadId > 0);
assert.equal(result.byte, 42);
assert.equal(result.cycle, true);
assert.equal(result.map, true);
assert.equal(result.env, "yes");
assert.deepEqual(result.argv.slice(2), ["arg", "2"]);
assert.equal(result.inherited.value, 1);
assert.equal(await exit(worker), 0);
assert.equal(stdout, "worker stdout\n");
assert.equal(stderr, "worker stderr\n");
assert.equal(process.env.WORKER_ONLY, undefined);
console.log("worker guest, data, options, online, stdio");

const evalWorker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); globalThis.workerPrivate=1; parentPort.postMessage({argv:process.argv,data:workerData});`, { eval: true, workerData: 7 });
const evalExit = exit(evalWorker);
const evaluated = await message(evalWorker);
assert.equal(evaluated.data, 7);
assert.equal(evaluated.argv[1], "[worker eval]");
assert.equal((globalThis as any).workerPrivate, undefined);
assert.equal(await evalExit, 0);
console.log("eval isolation");

const dataWorker = new Worker(new URL("data:text/javascript," + encodeURIComponent("import {parentPort} from 'node:worker_threads'; parentPort.postMessage(8)")));
const dataExit = exit(dataWorker);
assert.equal(await message(dataWorker), 8);
assert.equal(await dataExit, 0);
const preloaded = new Worker("require('worker_threads').parentPort.postMessage({value:globalThis.preloaded,execArgv:process.execArgv})", { eval: true, execArgv: ["--require", "./preload.cjs"] });
const preloadExit = exit(preloaded);
const preloadValue = await message(preloaded);
assert.equal(preloadValue.value, 23);
assert.deepEqual(preloadValue.execArgv, ["--require", "./preload.cjs"]);
assert.equal(await preloadExit, 0);
console.log("data URL and execArgv preload");

const roundtrip = new Worker(`const {parentPort}=require('worker_threads'); parentPort.once('message',value=>parentPort.postMessage(value,[value.buffer]));`, { eval: true });
const roundtripExit = exit(roundtrip);
const large = new Uint8Array(1200000);
large[0] = 42; large[large.length - 1] = 17;
const returned = message(roundtrip);
roundtrip.postMessage(large, [large.buffer]);
assert.equal(large.byteLength, 0);
const roundtripValue = await returned;
assert.equal(roundtripValue.length, 1200000);
assert.equal(roundtripValue[0], 42);
assert.equal(roundtripValue[roundtripValue.length - 1], 17);
assert.equal(await roundtripExit, 0);
console.log("large transferred messages cross pipe boundaries");

const first = new MessageChannel();
first.port1.postMessage({ queued: true });
const portWorker = new Worker(`const {parentPort,workerData,receiveMessageOnPort}=require('worker_threads'); const port=workerData; parentPort.postMessage(receiveMessageOnPort(port)); port.once('message', value=>{port.postMessage(value); port.close();});`, {
  eval: true, workerData: first.port2, transferList: [first.port2],
});
const portExit = exit(portWorker);
assert.deepEqual(await message(portWorker), { message: { queued: true } });
const echoed = new Promise(resolve => first.port1.once("message", resolve));
first.port1.postMessage({ echo: 3 });
assert.deepEqual(await echoed, { echo: 3 });
assert.equal(await portExit, 0);
first.port1.close();
console.log("transferred port and queued messages");

const receiving = new Worker(`const {parentPort}=require('worker_threads'); const {port1,port2}=new (require('worker_threads').MessageChannel)(); parentPort.postMessage(port1,[port1]); port2.once('message',value=>{port2.postMessage(value);port2.close();});`, { eval: true });
const receivingExit = exit(receiving);
const receivedPort = await message(receiving);
const receipt = new Promise(resolve => receivedPort.once("message", resolve));
receivedPort.postMessage(9);
assert.equal(await receipt, 9);
receivedPort.close();
assert.equal(await receivingExit, 0);
console.log("port transferred from worker");

const shared = new Worker(`const {parentPort}=require('worker_threads'); process.env.SHARED_WORKER='yes'; parentPort.once('message',()=>parentPort.postMessage(process.env.SHARED_PARENT));`, { eval: true, env: SHARE_ENV });
const sharedExit = exit(shared);
process.env.SHARED_PARENT = "yes";
shared.postMessage("read");
assert.equal(await message(shared), "yes");
assert.equal(await sharedExit, 0);
assert.equal(process.env.SHARED_WORKER, "yes");
delete process.env.SHARED_WORKER;
delete process.env.SHARED_PARENT;
console.log("shared environment");

const exited = new Worker(`process.on('exit',()=>require('worker_threads').parentPort.postMessage('from exit'));process.exit(7)`, { eval: true });
const isolatedExit = exit(exited);
assert.equal(await message(exited), "from exit");
assert.equal(await isolatedExit, 7);
assert.equal(1 + 1, 2);
console.log("worker process exit is isolated");

const failed = new Worker(`throw new TypeError('worker failure')`, { eval: true, stderr: true });
const failure = new Promise<Error>(resolve => failed.once("error", resolve));
const failureExit = new Promise<number>(resolve => failed.once("exit", resolve));
const error = await failure;
assert.equal(error.name, "TypeError");
assert.equal(error.message, "worker failure");
assert.equal(await failureExit, 1);
console.log("worker error and exit");

const busy = new Worker(`const {parentPort}=require('worker_threads'); parentPort.postMessage('ready'); for (;;) {}`, { eval: true });
assert.equal(await message(busy), "ready");
const termination = busy.terminate();
assert.equal(await termination, 1);
console.log("worker termination");

const flooding = new Worker(`const {parentPort}=require('worker_threads');for(;;)parentPort.postMessage(1);`, { eval: true });
const floodingExit = exit(flooding);
let delivered = 0;
flooding.on("message", () => { if (++delivered === 10) void flooding.terminate(); });
assert.equal(await floodingExit, 1);
assert.ok(delivered >= 10);
console.log("worker message flood remains interruptible");

for (let index = 0; index < 10; index++) {
  const nested = new Worker(`const {Worker,parentPort}=require('worker_threads'); const w=new Worker("require('worker_threads').parentPort.postMessage(12)",{eval:true}); w.on('message',value=>parentPort.postMessage(value));`, { eval: true });
  const nestedExit = exit(nested);
  assert.equal(await message(nested), 12);
  assert.equal(await nestedExit, 0);
}
console.log("nested worker");

const detached = new Worker(`setInterval(()=>{},1000)`, { eval: true });
detached.unref();
detached.ref();
await detached.terminate();
console.log("worker ref and unref");
