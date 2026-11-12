// The ordinary production-page control uses the same identity assertions as cross-worker.ts.
// This worker exits naturally, so it needs no injected page-side termination observer.
import { strict as assert } from "node:assert";
import { Worker } from "node:worker_threads";

const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/cross-worker.wasm`).arrayBuffer());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
const view = new Int32Array(memory.buffer);
const exports = new WebAssembly.Instance(module, { env: { memory, observe() {} } }).exports as {
  read(address: number): number; write(address: number, value: number): void; pages(): number;
};
Atomics.store(view, 0, 11);
const worker = new Worker(`${import.meta.dir}/cross-worker-child.ts`, { workerData: { mode: "identity", memory, module } });
const exited = new Promise<number>((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
assert.deepEqual(await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }), { seen: 11, alias: 131072 });
if (Atomics.wait(view, 6, 0, 30_000) === "timed-out") throw new Error("Timed out waiting on word 6");
assert.equal(Atomics.load(view, 6), 1);
assert.equal(Atomics.load(view, 1), 12, "nested write in the worker reaches a JS view here");
assert.equal(exports.read(8), 13, "JS write in the worker reaches nested code here");
assert.equal(await exited, 0);
const before = view.buffer;
assert.equal(memory.buffer.byteLength, 131072);
assert.equal(exports.pages(), 2);
assert.notEqual(memory.buffer, before);
assert.equal(before.byteLength, 65536);
exports.write(0, 21);
assert.equal(new Int32Array(memory.buffer)[0], 21);
assert.equal(new Int32Array(before)[0], 21);

// An ordinary process gets a fresh group, while retaining this page's selected program profile.
const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/index.ts`], { stdout: "pipe", stderr: "inherit" });
const output = await new Response(child.stdout).text();
assert.equal(await child.exited, 0, output);
assert.ok(output.includes("shared-wasm-memory: pass"), output);
console.log("profile-worker: pass");
