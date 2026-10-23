// Object URLs across workers: blob entries, revocation before load, and fetch from another guest.
import { Worker as ThreadWorker } from "node:worker_threads";

const echo = URL.createObjectURL(new Blob(["self.onmessage = e => self.postMessage(e.data)"], { type: "application/javascript" }));
const worker = new Worker(echo);
console.log("echo", await new Promise(resolve => {
  worker.onmessage = event => resolve(event.data);
  worker.postMessage("hello");
}));
URL.revokeObjectURL(echo);
console.log("after revoke", await new Promise(resolve => {
  worker.onmessage = event => resolve(event.data);
  worker.postMessage("still running");
}));
worker.terminate();

const late = URL.createObjectURL(new Blob(["self.postMessage('survived')"], { type: "application/javascript" }));
const revoked = new Worker(late);
URL.revokeObjectURL(late);
console.log("revoked before load", await new Promise(resolve => {
  revoked.onmessage = event => resolve(event.data);
  revoked.onerror = event => { event.preventDefault(); resolve(event.message); };
}));

const named = new File(["shared bytes"], "ignored");
named.name = "renamed";
const local = URL.createObjectURL(named);
const fetched = await (await fetch(local)).blob();
console.log("local fetch", await fetched.text(), fetched.name);

const creator = new ThreadWorker(`
  const { parentPort } = require("node:worker_threads");
  const file = new File(["from a worker"], "ignored");
  file.name = "worker-file";
  const url = URL.createObjectURL(file);
  parentPort.postMessage(url);
  parentPort.once("message", () => { URL.revokeObjectURL(url); parentPort.postMessage("revoked"); });
`, { eval: true });
const shared = await new Promise<string>(resolve => creator.once("message", resolve));
const reader = new ThreadWorker(`
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", async url => {
    try {
      const blob = await (await fetch(url)).blob();
      parentPort.postMessage([await blob.text(), blob.name]);
    } catch (error) {
      parentPort.postMessage([error.name, error.code]);
    }
  });
`, { eval: true });
const read = (url: string) => new Promise(resolve => {
  reader.once("message", resolve);
  reader.postMessage(url);
});
const fromMain = await (await fetch(shared)).blob();
console.log("main reads worker URL", await fromMain.text(), fromMain.name);
console.log("worker reads worker URL", JSON.stringify(await read(shared)));
creator.postMessage("revoke");
await new Promise(resolve => creator.once("message", resolve));
console.log("after creator revoked", JSON.stringify(await read(shared)));
try {
  await fetch(shared);
} catch (error) {
  console.log("main after revoke", (error as Error).name, (error as { code?: string }).code);
}
await creator.terminate();
await reader.terminate();
