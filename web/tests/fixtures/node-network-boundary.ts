import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { readOutcome } from "waffle/proc/outcome";
import { guest } from "../../../scripts/fixtures/shared-objects/executor-guest.ts";

const adapter = process.argv[2];
assert(adapter === "bun" || adapter === "wasi");
const transport = createWorkerProcessTransport();
const worker = new Worker(new URL("../../scripts/node-host.ts", import.meta.url), {
  workerData: {
    module: guest(0), adapter, transport,
    settings: { wasmPath: "unused.wasm", engines: {}, stackMb: 32, withNet: true,
      preopens: {}, env: {}, args: [], context: "native", modules: "store" },
  },
});
try {
  const code = await new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  console.log(JSON.stringify({ code, outcome: readOutcome(workerProcessState(transport).signals.outcome) }));
} finally { await worker.terminate(); }
