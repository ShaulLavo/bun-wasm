import { expect, test } from "bun:test";
import { join } from "node:path";
import { SLOT_NAMES, installHostSlots } from "../src/net/trampoline";
import { testCompose } from "./compose";
import { readFileSync } from "node:fs";
import { MemFS } from "../src/fs";
import { memoryViews } from "waffle/core";
import { HOST_CALL_FD } from "../src/net/trampoline";
import { Wasi } from "waffle/core";
import { instantiateLinkPlan, prepareLinkPlan } from "waffle/link";
import { quickjsLinkPlan } from "../../src/quickjs-program.ts";

const wasm = new URL("../../dist/bun.wasm", import.meta.url);
async function memoryGrowth(fallback: boolean) {
  const plan = await prepareLinkPlan(quickjsLinkPlan(readFileSync(wasm), readFileSync(new URL("quickjs.wasm", wasm))));
  const module = plan.entryModule;
  // The guest imports runtime_proc directly; this test never calls it.
  const runtimeProc = Object.fromEntries(WebAssembly.Module.imports(module).filter(entry => entry.module === "runtime_proc").map(entry => [entry.name, () => 0]));
  const wasi = new Wasi({ hostCallFd: HOST_CALL_FD, args: ["bun", "--version"], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {}, namespaces: { runtime_proc: runtimeProc } });
  const imports = wasi.imports(module);
  const group = instantiateLinkPlan(plan, { wasi, coreImports: imports, checkActive() {} });
  try {
    const instance = group.entry;
    group.initialize();
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory export is missing");
    if (fallback) Object.defineProperty(memory, "toResizableBuffer", { value: undefined });
    expect(wasi.start(instance)).toBe(0);
    const views = memoryViews(memory);
    const end = memory.buffer.byteLength;
    const saved = views.view().getInt32(0, true);
    views.view().setInt32(0, 7, true);
    wasi.hostCall = (slot) => {
      expect(slot).toBe(7);
      memory.grow(1);
      return 42;
    };
    const sockSend = imports.wasi_snapshot_preview1?.sock_send;
    if (typeof sockSend !== "function") throw new Error("WASI sock_send import is missing");
    expect(Reflect.apply(sockSend, null, [HOST_CALL_FD, 0, 5, 0, end + 8])).toBe(0);
    expect(views.view().getInt32(end + 8, true)).toBe(42);
    views.view().setInt32(0, saved, true);
  } finally { group.dispose(); }
}

for (const fallback of [false, true]) {
  test(`WASI reacquires memory after a growing host callback (fallback=${fallback})`, () => memoryGrowth(fallback));
}

const bunWasm = join(import.meta.dir, "../../dist/bun.wasm");
test("installHostSlots fills bun.wasm's slot table", () => {
  const module = new WebAssembly.Module(readFileSync(bunWasm));
  // The guest imports runtime_proc directly; this test only inspects the slot table, so stub it.
  const runtimeProc = Object.fromEntries(WebAssembly.Module.imports(module).filter(entry => entry.module === "runtime_proc").map(entry => [entry.name, () => 0]));
  const wasi = new Wasi({ args: ["bun"], env: {}, fs: new MemFS(), preopens: { "/": "/" }, stdout() {}, stderr() {}, sleep() {}, namespaces: { runtime_proc: runtimeProc } });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  const installed = installHostSlots(instance, { poll: () => 0, fetch: () => -1, close: () => 0 });
  expect(installed).toEqual(["poll", "fetch", "close"]);
  const ptr = (instance.exports.bun_wasm_host_slots as () => number)();
  const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
  expect(view.getUint32(ptr, true)).toBe(1);
  expect(view.getUint32(ptr + 4, true)).toBe(SLOT_NAMES.length);
  expect(SLOT_NAMES).toHaveLength(14);
  const table = instance.exports.__indirect_function_table as WebAssembly.Table;
  const slot = (i: number) => view.getUint32(ptr + 8 + 4 * i, true);
  expect(slot(0)).toBeGreaterThan(0);
  expect(slot(2)).toBe(0); // fetch_head not provided
  expect((table.get(slot(1)) as Function)(0, 0, 0, 0)).toBe(-1);
});

testCompose("bun.wasm");
