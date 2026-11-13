import { workerControlFixture } from "./worker-control-fixture.ts";
import { expect, test } from "bun:test";
import { Wasi } from "waffle/core";
import { createFilesystemConnection, FilesystemClient } from "waffle/fs";
import { MemFS } from "waffle/fs/memory";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
import { engineLinkPlan } from "../../src/quickjs-program.ts";
import { initializationPair } from "../../tests/package/engine-initialization-fixture.ts";
import { createBunExecutor, type RunRequest } from "../src/bun-executor.ts";
import { readFileSync } from "node:fs";

const STACK = BUN_MEMORY_GROUP_POLICY.stackBytes;
const GROUP_PAGES = BUN_MEMORY_GROUP_POLICY.maximumPages;
/** One past the last byte of a full Bun group: 0x80000000. */
const END = GROUP_PAGES * 65536;

test("Browser SpiderMonkey member stack size matches the side's bound derivation", () => {
  const vm = readFileSync(new URL("../../crates/bunwasm-engine-spidermonkey/src/vm.rs", import.meta.url), "utf8");
  expect(vm).toContain("const MEMBER_STACK_BYTES: usize = 8 << 20;");
  expect(STACK).toBe(8 * 1024 * 1024);
});

async function exercise(options: { engine?: RunRequest["engine"]; stackBytes?: number; low?: number; high?: number; pointer?: number; missing?: string; unbalance?: 1 | 8; pages?: number } = {}) {
  const { plan } = await engineLinkPlan(initializationPair("spidermonkey", true));
  const module = plan.entryModule;
  const low = options.low ?? 65536;
  const high = options.high ?? low + STACK;
  const pointer = new WebAssembly.Global({ value: "i32", mutable: true }, options.pointer ?? high);
  const got: WebAssembly.ModuleImports = {
    __stack_low: new WebAssembly.Global({ value: "i32", mutable: true }, low),
    __stack_high: new WebAssembly.Global({ value: "i32", mutable: true }, high),
  };
  const env: WebAssembly.ModuleImports = {
    memory: new WebAssembly.Memory({ initial: options.pages ?? 130, maximum: GROUP_PAGES, shared: true }),
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
    __stack_pointer: pointer,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 16),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
    trace(value: number) { trace.push(value); if (value === options.unbalance) pointer.value -= 16; },
  };
  const trace: number[] = [];
  const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {}, namespaces: { env, "GOT.mem": got, runtime_proc: { signal: () => 0 } } });
  const imports = wasi.imports(module, { env, "GOT.mem": got });
  // The real Wasi implementation must preserve object identity, not rebuild globals.
  expect(imports.env?.__stack_pointer).toBe(env.__stack_pointer);
  expect(imports["GOT.mem"]?.__stack_high).toBe(got.__stack_high);
  if (options.missing) delete (options.missing === "__stack_pointer" ? imports.env! : imports["GOT.mem"]!)[options.missing];
  const channel = new MessageChannel();
  const memory = env.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("fixture memory missing");
  const connection = createFilesystemConnection();
  const control = await workerControlFixture();
  const req: RunRequest = { controlGrant: control.grant, engine: options.engine ?? "spidermonkey", module, linkPlan: plan.shared, args: ["bun"], env: {}, trace: false, net: null, slots: "off", filesystem: connection.client,
    memoryGroup: { memory, control: new SharedArrayBuffer(32), reply: new SharedArrayBuffer(36), port: channel.port1, index: 0, watches: 1, parallelism: 1, stackBytes: options.stackBytes ?? STACK } };
  const executor = createBunExecutor(req);
  const context = { request: req, fs: new FilesystemClient(connection.client), isolated: true, outcome: null, runtimeState: null, identity: null, signal: AbortSignal.timeout(1000), defaultSignal() {}, post() { return true; }, finish() {}, wasi, checkActive() {}, bindMemory(memory: WebAssembly.Memory) { wasi.bindMemory(memory); } };
  try {
    if (!executor.instantiate) throw new Error("missing paired instantiator");
    const instance = await executor.instantiate(imports, context);
    const originalImports = wasi.imports;
    try { executor.initialize?.({ ...context, instance }); }
    finally { expect(wasi.imports).toBe(originalImports); }
    expect(trace).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // An i32 global holds the one-past-end address 0x80000000 as a negative number.
    expect(pointer.value >>> 0).toBe(high);
  } catch (error) {
    if (!options.unbalance) expect(trace).toEqual([]);
    throw error;
  } finally { executor.beforeFinish?.(); channel.port1.close(); channel.port2.close(); connection.client.port.close(); connection.server.port.close(); await control.dispose(); }
}

test("SpiderMonkey initializes with the real Wasi globals and an exact balanced carve", () => exercise());
for (const stackBytes of [1 << 20, STACK - 16, STACK + 16]) test(`SpiderMonkey refuses requested stack size ${stackBytes}`, async () => {
  await expect(exercise({ stackBytes })).rejects.toThrow("SpiderMonkey group stack");
});
for (const options of [{ low: 131072, high: STACK + 65536 }, { high: STACK + 65552, pointer: STACK + 65552 }, { pointer: STACK + 65520 }]) test(`SpiderMonkey refuses invalid carved bounds ${JSON.stringify(options)}`, async () => {
  await expect(exercise(options)).rejects.toThrow("SpiderMonkey group stack");
});
for (const missing of ["__stack_pointer", "__stack_low", "__stack_high"]) test(`SpiderMonkey refuses missing host global ${missing}`, async () => {
  await expect(exercise({ missing })).rejects.toThrow("SpiderMonkey group stack requires");
});
test("SpiderMonkey refuses a carve outside its memory", async () => {
  await expect(exercise({ low: STACK, high: 2 * STACK, pointer: 2 * STACK })).rejects.toThrow("SpiderMonkey group stack");
});
test("a member stack carved as the last chunk of a full 2 GiB group has its top at the signed endpoint", async () => {
  expect(END).toBe(0x8000_0000);
  await exercise({ pages: GROUP_PAGES, low: END - STACK, high: END });
});
test("SpiderMonkey refuses a carve that ends one page past the 2 GiB group", async () => {
  await expect(exercise({ pages: GROUP_PAGES, low: END - STACK + 65536, high: END + 65536 })).rejects.toThrow("SpiderMonkey group stack");
});
test("SpiderMonkey refuses an initializer that does not restore the stack pointer", async () => {
  await expect(exercise({ unbalance: 8 })).rejects.toThrow("SpiderMonkey group stack pointer was not restored");
});

test("SpiderMonkey refuses an unbalanced core memory stage before wrapping side imports", async () => {
  await expect(exercise({ unbalance: 1 })).rejects.toThrow("SpiderMonkey group stack pointer was not restored");
});

test("SpiderMonkey group admission cannot bypass its stack contract by selecting the browser engine", async () => {
  await expect(exercise({ engine: "browser", stackBytes: 1 << 20 })).rejects.toThrow("Selected browser engine differs from paired core declaration");
});
