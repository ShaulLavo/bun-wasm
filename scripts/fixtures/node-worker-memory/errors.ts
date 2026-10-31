import { parentPort, workerData } from "node:worker_threads";

if (workerData === "ordinary") {
  throw Object.assign(new Error("ordinary worker failure"), { code: "E_NODE_WORKER_TEST" });
}
parentPort?.postMessage("ready");
setInterval(() => {}, 1000);
