import { Worker } from "node:worker_threads";
const worker = new Worker(new URL("./worker.cjs", import.meta.url), { workerData: 41, execArgv: [] });
const message = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
console.log("worker replied", message);
