import { parentPort, workerData } from "node:worker_threads";
import { echo } from "./abstract-peer.ts";

parentPort!.postMessage(await echo(workerData.name, "worker"));
