// process.env clones as a plain object, and worker execArgv flags take effect.
import { Worker } from "node:worker_threads";

process.env.CENSUS_VALUE = "kept";
const clone = structuredClone(process.env);
console.log("clone", typeof clone, clone.CENSUS_VALUE, Object.getPrototypeOf(clone) === Object.prototype);
try {
  structuredClone(new Proxy({}, {}));
  console.log("proxy cloned");
} catch (error) {
  console.log("proxy", (error as Error).name);
}

const { port1, port2 } = new MessageChannel();
port1.postMessage(process.env);
const posted = await new Promise<Record<string, string>>(resolve => {
  port2.onmessage = event => resolve(event.data);
});
port1.close();
port2.close();
console.log("posted", posted.CENSUS_VALUE);

const worker = new Worker(
  `const { parentPort } = require("node:worker_threads");
  const tls = require("node:tls");
  process.emitWarning("hidden", "DeprecationWarning");
  parentPort.postMessage({ env: process.env, noDeprecation: process.noDeprecation, min: tls.DEFAULT_MIN_VERSION, max: tls.DEFAULT_MAX_VERSION, execArgv: process.execArgv });`,
  { eval: true, execArgv: ["--no-deprecation", "--tls-min-v1.3", "--tls-max-v1.3"] },
);
const reply = await new Promise<Record<string, unknown>>(resolve => worker.once("message", resolve));
const { env, ...flags } = reply;
console.log("worker env", (env as Record<string, string>).CENSUS_VALUE);
console.log("worker flags", JSON.stringify(flags));
await worker.terminate();
