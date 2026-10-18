// Publish authoritative handled state without the process wake or interrupt hint. A preview1
// wait must observe it even when another consumer already consumed those wake hints.
import { parentPort, workerData } from "node:worker_threads";
import { SIGNAL_PENDING, SignalDisposition } from "waffle/proc/signals";
import { workerProcessState, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { controlStore } from "waffle/proc/control";
const state = workerProcessState(workerData as WorkerProcessTransport).signals.signalState;
parentPort!.postMessage("ready");
setTimeout(() => controlStore(state, 15, SignalDisposition.HANDLE | SIGNAL_PENDING), 20);
