import assert from "node:assert/strict";
import { once } from "node:events";
import type { WorkerOptions } from "node:worker_threads";
import { createNodeWorker } from "../web/scripts/node-worker.ts";

const source = process.argv[3];
assert(source);
const url = new URL("./fixtures/node-worker-memory/compiler.ts", import.meta.url);

async function compile(options: WorkerOptions, expectedHeap: number, expectedStack: number) {
  const worker = createNodeWorker(url, { ...options, workerData: source }, 32);
  try {
    const output = once(worker, "message");
    assert.equal(worker.resourceLimits.maxOldGenerationSizeMb, expectedHeap);
    assert.equal(worker.resourceLimits.stackSizeMb, expectedStack);
    const [code] = await output;
    assert.equal(typeof code, "string");
    assert.match(code, /exports\.default/);
  } finally {
    await worker.terminate();
  }
}

async function outOfMemory() {
  const worker = createNodeWorker(url, { workerData: source, resourceLimits: { maxOldGenerationSizeMb: 8 } }, 32);
  try {
    const exited = new Promise(resolve => worker.once("exit", resolve));
    const error: unknown = await new Promise((resolve, reject) => {
      worker.once("error", resolve);
      worker.once("exit", code => reject(new Error(`Compiler exited without OOM: ${code}`)));
    });
    assert(error instanceof Error && "code" in error);
    assert.equal(error.code, "ERR_WORKER_OUT_OF_MEMORY");
    assert.equal(await exited, 1);
  } finally {
    await worker.terminate();
  }
}

if (process.argv[2] === "oom") await outOfMemory();
else {
  await compile({}, 512, 32);
  await compile({ resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 64 } }, 96, 64);
  await compile({ resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } }, 96, 32);
}
console.log("node worker memory contract passed");
