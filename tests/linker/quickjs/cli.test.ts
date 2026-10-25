import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MessagePort, Worker } from "node:worker_threads";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "waffle/fs";
import { prepareLinkPlan } from "waffle/link";
import { createWorkerProcessTransport } from "waffle/proc";

async function runCLI(args: string[], files: Readonly<Record<string, Uint8Array | string>>) {
  const directory = process.env.BUN_CORE_BUILD_DIR;
  assert(directory, "BUN_CORE_BUILD_DIR must name matching newly built production artifacts");
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
  const backend = new MemoryBackend();
  for (const [name, source] of Object.entries(files)) backend.fs.writeFile(name, source);
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const filesystemPort = connection.client.port;
  assert(filesystemPort instanceof MessagePort);
  const worker = new Worker(new URL("./checkpoint-worker.ts", import.meta.url), {
    workerData: {
      module: plan.entryModule, linkPlan: plan.toSource(),
      args, env: {}, filesystem: connection.client,
      runtimeProcess: createWorkerProcessTransport(),
    },
    transferList: [filesystemPort],
  });
  const messages: unknown[] = [];
  try {
    await collectMessages(worker, messages);
    assert(messages.some((message) => isCleanup(message) && message.finished === 1));
    assert(!messages.some((message) => isError(message)), JSON.stringify(messages));
    const exit = messages.find(isExit);
    assert(exit, JSON.stringify(messages));
    return { stdout: output(messages, "stdout"), stderr: output(messages, "stderr"), code: exit.code,
      artifacts: [core, engine].map((bytes) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) };
  } finally {
    await worker.terminate();
    connection.server.port.close();
    service.dispose();
  }
}

test("split production CLI imports TypeScript, drains promise jobs and a timer in the ordinary Waffle worker", async () => {
  const files: Record<string, Uint8Array> = {};
  for (const name of ["main.ts", "value.ts"]) files[`/${name}`] = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  const result = await runCLI(["bun", "run", "/main.ts"], files);
  assert.equal(result.stdout, "42\n");
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  console.log(JSON.stringify({ checkpoint: "production-driver", ...result, cleanup: 1 }));
}, 30_000);

test("split eval preserves ticks, jobs, beforeExit work and final exit code", async () => {
  const source = `
    const seen = [];
    process.nextTick(() => seen.push("tick"));
    Promise.resolve().then(() => seen.push("job"));
    process.once("beforeExit", () => setTimeout(() => {
      if (seen.join() !== "tick,job") throw Error(seen.join());
      console.log(42);
      process.exitCode = 7;
    }, 1));
  `;
  const result = await runCLI(["bun", "-e", source], {});
  assert.equal(result.stdout, "42\n");
  assert.equal(result.stderr, "");
  assert.equal(result.code, 7);
}, 30_000);

test("split loader keeps CommonJS, builtin wrappers and structured native errors", async () => {
  const result = await runCLI(["bun", "run", "/main.ts"], {
    "/main.ts": `import path from "node:path"; import value from "./value.cjs";
      import { readFileSync } from "node:fs";
      let missing = false;
      try { readFileSync("/missing"); } catch (error) { missing = error.code === "ENOENT"; }
      if (!missing || path.basename("/a/value") !== "value" || !import.meta.main) throw Error("loader");
      console.log(value);`,
    "/value.cjs": "module.exports = 42;",
  });
  assert.equal(result.stdout, "42\n");
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
}, 30_000);

test("split driver reports a rejected main once and drops unresolved top-level await", async () => {
  const rejected = await runCLI(["bun", "-e", 'await Promise.reject(Error("split-rejection"))'], {});
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr.split("error: split-rejection").length - 1, 1);
  const pending = await runCLI(["bun", "-e", "await new Promise(() => {})"], {});
  assert.equal(pending.code, 0);
  assert.equal(pending.stdout, "");
  assert.equal(pending.stderr, "");
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
