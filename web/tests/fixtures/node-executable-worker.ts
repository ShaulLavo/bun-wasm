import { workerData } from "node:worker_threads";

const instance = new WebAssembly.Instance(workerData.module as WebAssembly.Module);
process.exit((instance.exports.status as () => number)());
