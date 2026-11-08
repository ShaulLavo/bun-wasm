import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { addons, object, type Addon } from "./config.ts";
import { digest } from "./acquire.ts";
import { wasmMemoryLimits } from "../../src/engine-kind.ts";

function callable(record: Record<string, unknown>, name: string) {
  const fn = record[name];
  if (typeof fn !== "function") throw new Error(`Missing function ${name}`);
  return (...args: unknown[]): unknown => Reflect.apply(fn, record, args);
}

function numeric(fn: (...args: unknown[]) => unknown, value: number) {
  const result = fn(value);
  if (typeof result !== "number") throw new Error("Expected numeric allocator result");
  return result;
}

function observeRuntime(runtime: Record<string, unknown>) {
  const instantiate = callable(runtime, "instantiateNapiModuleSync");
  const instances: WebAssembly.Instance[] = [];
  const managers: Record<string, unknown>[] = [];
  const workers: Worker[] = [];
  const sentMemories: WebAssembly.Memory[] = [];
  runtime.instantiateNapiModuleSync = (...args: unknown[]) => {
    const options = object(args[1]);
    const create = callable(options, "onCreateWorker");
    options.onCreateWorker = () => observeWorker(create(), workers, sentMemories);
    const result = object(instantiate(...args));
    if (!(result.instance instanceof WebAssembly.Instance)) throw new Error("Missing real NAPI instance");
    instances.push(result.instance);
    managers.push(object(object(result.napiModule).PThread));
    return result;
  };
  return { instances, managers, workers, sentMemories };
}

function observeWorker(value: unknown, workers: Worker[], memories: WebAssembly.Memory[]) {
  if (!(value instanceof Worker)) throw new Error("Not a real Node worker");
  workers.push(value);
  const postMessage = value.postMessage;
  value.postMessage = function (...args: Parameters<Worker["postMessage"]>) {
    const envelope = object(args[0]).__emnapi__;
    if (envelope) recordMemory(object(envelope), memories);
    return postMessage.apply(this, args);
  };
  return value;
}

function recordMemory(envelope: Record<string, unknown>, memories: WebAssembly.Memory[]) {
  if (envelope.type !== "load") return;
  const memory = object(envelope.payload).wasmMemory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Worker received no genuine memory");
  memories.push(memory);
}

async function addonBehavior(addon: Addon, api: Record<string, unknown>) {
  for (const ident of addon.exports) assert.ok(ident in api, `Missing addon export ${ident}`);
  if (addon.addon === "parser") return parserBehavior(api);
  if (addon.addon === "transform") return transformBehavior(api);
  const result = object(callable(api, "minify")("x.js", "const x=1+2;console.log(x)", {}));
  assert.equal(result.code, "const x=3;console.log(3);");
  assert.deepEqual(result.errors, []);
  assertErrors(callable(api, "minify")("bad.js", "const = ;", {}));
  return { sync: true, async: "not exported by minify 0.94.0", errors: true };
}

async function parserBehavior(api: Record<string, unknown>) {
  const sync = object(callable(api, "parseSync")("x.ts", "const x: number=1", {}));
  const syncProgram = sync.program;
  assert.equal(JSON.parse(String(syncProgram)).node.body[0].type, "VariableDeclaration");
  assert.deepEqual(sync.errors, []);
  const asyncResult = object(await callable(api, "parseAsync")("x.ts", "const x: number=1", {}));
  assert.equal(asyncResult.program, syncProgram);
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => callable(api, "parseAsync")(`x${i}.ts`, `const x${i}: number=${i}`, {})));
  for (const result of concurrent) assert.deepEqual(object(result).errors, []);
  assertErrors(callable(api, "parseSync")("bad.ts", "const = ;", {}));
  assertErrors(await callable(api, "parseAsync")("bad.ts", "const = ;", {}));
  return { sync: true, async: true, concurrent: 8, errors: true };
}

async function transformBehavior(api: Record<string, unknown>) {
  const sync = object(callable(api, "transform")("x.ts", "export const x: number=1", {}));
  assert.equal(sync.code, "export const x = 1;\n");
  assert.deepEqual(sync.errors, []);
  const result = object(await callable(api, "transformAsync")("x.ts", "export const x: number=1", {}));
  assert.deepEqual(result, sync);
  await Promise.all(Array.from({ length: 8 }, (_, i) => callable(api, "transformAsync")(`x${i}.ts`, `export const x${i}: number=${i}`, {})));
  assertErrors(callable(api, "transform")("bad.ts", "const = ;", {}));
  assertErrors(await callable(api, "transformAsync")("bad.ts", "const = ;", {}));
  return { sync: true, async: true, concurrent: 8, errors: true };
}

function assertErrors(result: unknown) {
  const errors = object(result).errors;
  assert.ok(Array.isArray(errors) && errors.length > 0, "Expected actual addon diagnostics");
  assert.equal(typeof object(errors[0]).message, "string");
}

async function atomicsControl(memory: WebAssembly.Memory, pointer: number) {
  const prefix = new Int32Array(memory.buffer, pointer, 1);
  Atomics.store(prefix, 0, 0);
  const before = memory.buffer.byteLength;
  const worker = new Worker(new URL("./memory-worker.ts", import.meta.url), { workerData: { memory, pointer } });
  try {
    const result = await exchange(worker, prefix);
    assert.equal(Atomics.load(prefix, 0), 9);
    assert.equal(memory.buffer.byteLength, before + 65536);
    assert.equal(result.bytes, memory.buffer.byteLength);
    assert.equal(result.previousPages, before / 65536);
    assert.ok(result.wait === "ok" || result.wait === "not-equal");
    return { bytes: memory.buffer.byteLength, wait: result.wait, oldPrefixLive: true };
  } finally {
    await worker.terminate();
  }
}

function exchange(worker: Worker, prefix: Int32Array) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Atomics worker timeout")), 10_000);
    worker.once("error", error => { clearTimeout(deadline); reject(error); });
    worker.on("message", message => {
      const result = object(message);
      if (result.stage === "ready") { Atomics.store(prefix, 0, 7); Atomics.notify(prefix, 0); return; }
      clearTimeout(deadline);
      resolve(result);
    });
  });
}

function growthControl(instance: WebAssembly.Instance, maintained: boolean) {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing real exported memory");
  const malloc = callable(instance.exports, "malloc");
  const free = callable(instance.exports, "free");
  const pointer = numeric(malloc, 1024);
  assert.ok(pointer > 0);
  const prefix = new Uint8Array(memory.buffer, pointer, 1);
  prefix[0] = 73;
  const before = memory.buffer.byteLength;
  const large = numeric(malloc, 32 * 1024 * 1024);
  assert.ok(large > 0);
  const after = memory.buffer.byteLength;
  if (maintained) assert.ok(after > before, "Real allocator must grow beyond the 1024-page initial");
  assert.equal(prefix[0], 73);
  assert.equal(new Uint8Array(memory.buffer)[pointer], 73);
  free(large);
  return { memory, malloc, free, pointer, result: { before, after, userBytesPreserved: true } };
}

function capControl(memory: WebAssembly.Memory, malloc: (...args: unknown[]) => unknown) {
  const beforePages = memory.buffer.byteLength / 65536;
  memory.grow(4096 - beforePages);
  assert.equal(memory.buffer.byteLength, 4096 * 65536);
  const buffer = memory.buffer;
  assert.throws(() => memory.grow(1), RangeError);
  assert.equal(memory.buffer, buffer);
  assert.equal(numeric(malloc, 4096 * 65536), 0);
  assert.equal(memory.buffer, buffer);
  return { pages: 4096, js: { name: "RangeError", operation: "grow", delta: 1 }, allocator: { operation: "malloc", requestedBytes: 4096 * 65536, result: 0 } };
}

async function control(directory: string, dependencies: string, addon: Addon, maintained: boolean) {
  const require = createRequire(join(dependencies, "package.json"));
  const runtime = object(require(join(dependencies, "node_modules/@napi-rs/wasm-runtime/runtime.cjs")));
  const observed = observeRuntime(runtime);
  const deadline = setTimeout(() => { throw new Error("Addon control timeout"); }, 30_000);
  try {
    const bytes = await readFile(join(directory, `${addon.addon}.wasm32-wasi.wasm`));
    assert.equal(digest(bytes), addon.wasmSha256);
    const declarations = wasmMemoryLimits(bytes);
    assert.deepEqual(declarations, [{ initial: addon.minimumPages, maximum: 65536, shared: true, origin: "imported" }]);
    const api = object(require(directory));
    const instance = observed.instances[0];
    assert.ok(instance);
    const memory = instance.exports.memory;
    assert.ok(memory instanceof WebAssembly.Memory);
    assert.equal(Object.prototype.toString.call(memory.buffer), "[object SharedArrayBuffer]");
    const initialPages = memory.buffer.byteLength / 65536;
    assert.equal(initialPages, maintained ? 1024 : 4000);
    const growth = growthControl(instance, maintained);
    const behavior = await addonBehavior(addon, api);
    assert.equal(observed.managers[0]?.wasmMemory, memory);
    for (const sent of observed.sentMemories) assert.equal(sent, memory);
    if (addon.addon !== "minify") assert.ok(observed.workers.length > 0 && observed.sentMemories.length > 0);
    const atomics = await atomicsControl(memory, growth.pointer);
    const afterWorkerGrowth = await addonBehavior(addon, api);
    const cap = maintained ? capControl(memory, growth.malloc) : "original 65536-page cap not pressured";
    assert.equal(new Int32Array(memory.buffer, growth.pointer, 1)[0], 9);
    growth.free(growth.pointer);
    const small = numeric(growth.malloc, 16);
    assert.ok(small > 0, "Small allocation remains possible after refusal");
    growth.free(small);
    return { addon: addon.addon, maintained, exports: Object.keys(api).sort(), initialPages, declarations, growth: growth.result, behavior, afterWorkerGrowth, napiWorkers: observed.workers.length, workerMemoryLoads: observed.sentMemories.length, atomics, cap,
      limits: "Node NAPI controls. Atomics/growth worker is a separate real worker, not an Oxc callback. No framework or browser acceptance." };
  } finally {
    await Promise.all(observed.workers.map(worker => worker.terminate()));
    clearTimeout(deadline);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [directory, dependencies, kind, mode] = process.argv.slice(2);
  const addon = addons.find(item => item.addon === kind);
  if (!directory || !dependencies || !addon || !["original", "maintained"].includes(mode ?? "")) throw new Error("Invalid control arguments");
  process.stdout.write(JSON.stringify(await control(directory, dependencies, addon, mode === "maintained")) + "\n");
}
