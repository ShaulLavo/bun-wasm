import { expect, test } from "bun:test";
import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { instantiateLinkPlan, prepareLinkPlan, type LinkHost } from "waffle/link";
import { engineLinkPlan } from "../../src/quickjs-program.ts";
import { initializationPair } from "./engine-initialization-fixture.ts";

function host(trace: number[], shared: boolean): LinkHost {
  const env = { trace: (value: number) => trace.push(value) };
  const runtime_proc = { signal: () => 0 };
  const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {}, namespaces: { env, runtime_proc } });
  if (!shared) return { wasi, checkActive() {} };
  return { wasi, checkActive() {}, coreImports: { runtime_proc, env: {
    ...env, memory: new WebAssembly.Memory({ initial: 1, maximum: 16384, shared: true }),
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 65536),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 16),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
  } } };
}

for (const kind of ["quickjs", "jsc", "hermes"] as const) {
  test(`${kind} split links passive side data before relocation, constructors and registration`, async () => {
    const trace: number[] = [];
    const source = await engineLinkPlan(initializationPair(kind));
    const group = instantiateLinkPlan(await prepareLinkPlan(source), host(trace, false));
    try {
      expect(new DataView(group.memory.buffer).getUint32(16, true)).toBe(42);
      expect(trace).toEqual([]);
      expect(group.libraries).toEqual([]);
      group.initialize();
      expect(trace).toEqual([3, 4, 5, 6, 7, 8]);
      expect(new DataView(group.memory.buffer).getUint32(group.libraries[0]!.memoryBase, true)).toBe(23);
      group.initialize();
      expect(trace).toEqual([3, 4, 5, 6, 7, 8]);
    } finally { group.dispose(); }
  });
}

test("shared QuickJS core memory and relocation finish before escape, then constructors precede side linking", async () => {
  const trace: number[] = [];
  const source = await engineLinkPlan(initializationPair("quickjs", true));
  const group = instantiateLinkPlan(await prepareLinkPlan(structuredClone(source)), host(trace, true));
  try {
    expect(new DataView(group.memory.buffer).getUint32(16, true)).toBe(43);
    expect(trace).toEqual([1, 2]);
    expect(group.libraries).toEqual([]);
    group.initialize();
    expect(trace).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new DataView(group.memory.buffer).getUint32(group.libraries[0]!.memoryBase, true)).toBe(23);
    group.initialize();
    expect(trace).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  } finally { group.dispose(); }
});

test("passive memory cannot be skipped or scheduled after relocation", async () => {
  const source = await engineLinkPlan(initializationPair("quickjs", true));
  await expect(prepareLinkPlan({ ...source, core: { ...source.core, initializeMemory: [] } })).rejects.toThrow("passive data requires declared memory stages");
  await expect(prepareLinkPlan({ ...source, core: { ...source.core, initializeMemory: source.core.initializeMemory.toReversed() } })).rejects.toThrow("relocation cannot precede passive memory initialization");
  const side = source.libraries[0]!;
  await expect(prepareLinkPlan({ ...source, libraries: [{ ...side, initializeMemory: [] }] })).rejects.toThrow("passive data requires declared memory stages");
});
