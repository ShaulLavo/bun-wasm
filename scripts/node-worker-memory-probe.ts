import assert from "node:assert/strict";
import { once } from "node:events";
import { closeSync } from "node:fs";
import type { WorkerOptions } from "node:worker_threads";
import { createNodeWorker } from "../web/scripts/node-worker.ts";

const source = process.argv[3];
assert(source);
const url = new URL("./fixtures/node-worker-memory/compiler.ts", import.meta.url);

async function compile(options: WorkerOptions, expectedHeap: number, expectedStack: number) {
  const worker = createNodeWorker(url, { ...options, workerData: source }, 32);
  try {
    const output = once(worker, "message");
    assert(worker.resourceLimits);
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

async function closedDiagnosticSink() {
  const worker = createNodeWorker(new URL("./fixtures/node-worker-memory/errors.ts", import.meta.url), {}, 32);
  const original = Object.assign(new Error("diagnostic sink fault injection"), { code: "ERR_WORKER_OUT_OF_MEMORY" });
  const observations: string[] = [];
  try {
    await once(worker, "message");
    const exited = new Promise(resolve => worker.once("exit", resolve));
    worker.on("error", error => {
      assert.equal(error, original);
      assert.equal(original.code, "ERR_WORKER_OUT_OF_MEMORY");
      observations.push("broker");
      void worker.terminate();
    });
    worker.on("error", error => {
      assert.equal(error, original);
      observations.push("later");
    });
    closeSync(2);
    assert.doesNotThrow(() => worker.emit("error", original));
    assert.equal(await exited, 1);
    assert.deepEqual(observations, ["broker", "later"]);
  } finally {
    await worker.terminate();
  }
}

async function ordinaryError() {
  const worker = createNodeWorker(new URL("./fixtures/node-worker-memory/errors.ts", import.meta.url), { workerData: "ordinary" }, 32);
  try {
    const exited = new Promise(resolve => worker.once("exit", resolve));
    const [error]: unknown[] = await once(worker, "error");
    assert(error instanceof Error && "code" in error);
    assert.equal(error.code, "E_NODE_WORKER_TEST");
    assert.equal(error.message, "ordinary worker failure");
    assert.equal(await exited, 1);
  } finally {
    await worker.terminate();
  }
}

if (process.argv[2] === "oom") await outOfMemory();
else if (process.argv[2] === "sink-failure") await closedDiagnosticSink();
else if (process.argv[2] === "ordinary") await ordinaryError();
else {
  await compile({}, 512, 32);
  await compile({ resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 64 } }, 96, 64);
  await compile({ resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } }, 96, 32);
}
console.log("node worker memory contract passed");
