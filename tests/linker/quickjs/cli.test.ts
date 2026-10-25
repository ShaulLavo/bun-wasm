import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MessagePort, Worker } from "node:worker_threads";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "waffle/fs";
import { prepareLinkPlan } from "waffle/link";
import { createWorkerProcessTransport } from "waffle/proc";

const directory = process.env.BUN_CORE_BUILD_DIR;
assert(directory, "BUN_CORE_BUILD_DIR must name matching newly built production artifacts");

test("production CLI enters one registered QuickJS RUN in the ordinary Waffle worker", async () => {
  const core = new Uint8Array(await readFile(join(directory, "bun-core.wasm")));
  const engine = new Uint8Array(await readFile(join(directory, "quickjs.wasm")));
  const plan = await prepareLinkPlan({
    core: {
      id: "bun-core", source: core, cooperative: true,
      checkpoint: { module: "runtime_proc", name: "signal" },
      initialize: ["__wasm_call_ctors"],
    },
    libraries: [{
      id: "quickjs", source: engine, cooperative: true,
      checkpoint: { module: "env", name: "core_checkpoint" },
      initialize: ["quickjs_initialize_memory", "quickjs_apply_data_relocs", "quickjs_call_ctors", "quickjs_register"],
    }],
    reserve: "bun_core_alloc",
  });
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const filesystemPort = connection.client.port;
  assert(filesystemPort instanceof MessagePort);
  const worker = new Worker(new URL("./checkpoint-worker.ts", import.meta.url), {
    workerData: {
      module: plan.entryModule, linkPlan: plan.toSource(),
      args: ["bun", "-e", "42"], env: {}, filesystem: connection.client,
      runtimeProcess: createWorkerProcessTransport(),
    },
    transferList: [filesystemPort],
  });
  const messages: unknown[] = [];
  try {
    await collectMessages(worker, messages);
    assert.equal(output(messages, "stdout"), "42\n", JSON.stringify(messages));
    assert.equal(output(messages, "stderr"), "");
    assert(messages.some((message) => isExit(message) && message.code === 0), JSON.stringify(messages));
    assert(messages.some((message) => isCleanup(message) && message.finished === 1));
    assert(!messages.some((message) => isError(message)), JSON.stringify(messages));
    console.log(JSON.stringify({
      checkpoint: "production-entry", stdout: "42\\n", exit: 0, stderr: "", cleanup: 1,
      artifacts: [core, engine].map((bytes) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })),
    }));
  } finally {
    await worker.terminate();
    connection.server.port.close();
    service.dispose();
  }
}, 30_000);

function isExit(value: unknown): value is { type: "exit"; code: number } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "exit" && "code" in value && typeof value.code === "number";
}

function isCleanup(value: unknown): value is { checkpoint: "cleanup"; finished: number } {
  return typeof value === "object" && value !== null && "checkpoint" in value && value.checkpoint === "cleanup" && "finished" in value && typeof value.finished === "number";
}

function isError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === "error";
}

function output(messages: readonly unknown[], type: "stdout" | "stderr"): string {
  const bytes = messages.flatMap((message) => {
    if (typeof message !== "object" || message === null || !("type" in message) || message.type !== type) return [];
    if (!("data" in message) || !(message.data instanceof Uint8Array)) return [];
    return [message.data];
  });
  return Buffer.concat(bytes).toString();
}

function collectMessages(worker: Worker, messages: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.on("message", (message: unknown) => messages.push(message));
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve() : reject(Error(`worker exit ${code}`)));
  });
}
