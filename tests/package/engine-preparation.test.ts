import { expect, test } from "bun:test";
import { adoptLinkPlan } from "waffle/link";
import { BunWasmAssetError, prepareProgram, programMetadata } from "../../src/assets.ts";
import { appendCustomSection, pairedEngineKinds } from "../../src/engine-kind.ts";
import { engineLinkPlan } from "../../src/quickjs-program.ts";
import { initializationPair } from "./engine-initialization-fixture.ts";

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Count real asynchronous compiles while refusing every instantiation and synchronous compile. */
async function preparingOnly(run: (calls: string[], modules: WebAssembly.Module[]) => Promise<void>): Promise<void> {
  const { compile, Module, Instance, instantiate } = WebAssembly;
  const calls: string[] = [];
  const modules: WebAssembly.Module[] = [];
  WebAssembly.compile = source => {
    const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
    calls.push(digest(bytes));
    return compile(Uint8Array.from(bytes)).then(module => { modules.push(module); return module; });
  };
  Reflect.set(WebAssembly, "Module", new Proxy(Module, { construct() { throw new Error("Synchronous compile during preparation"); } }));
  Reflect.set(WebAssembly, "Instance", new Proxy(Instance, { construct() { throw new Error("Instantiation during preparation"); } }));
  WebAssembly.instantiate = new Proxy(instantiate, { apply() { throw new Error("Instantiation during preparation"); } });
  try { await run(calls, modules); }
  finally { Object.assign(WebAssembly, { compile, Module, Instance, instantiate }); }
}

for (const kind of pairedEngineKinds) for (const shared of [false, true]) {
  const label = `${kind} ${shared ? "shared" : "private"}`;
  test(`${label} snapshots inputs and compiles its exact side once before publishing`, async () => {
    const pair = initializationPair(kind, shared);
    const coreHash = digest(pair.core);
    const sideHash = digest(pair.side);
    const identity = new TextEncoder().encode(kind).length + 1;
    const expected = new Uint8Array(identity + 64);
    expected.set(new TextEncoder().encode(kind));
    expected.set(Buffer.from(coreHash, "hex"), identity);
    expected.set(Buffer.from(sideHash, "hex"), identity + 32);
    await preparingOnly(async calls => {
      const pending = prepareProgram(pair);
      pair.core.fill(0); pair.side.fill(0);
      const module = await pending;
      const metadata = programMetadata(module);
      expect(metadata.linkPlan).toBeDefined();
      expect(metadata.memoryLimitBytes).toBe(shared ? 2 ** 31 : null);
      expect(calls.filter(hash => hash === sideHash)).toHaveLength(1);
      expect(calls.filter(hash => hash === coreHash)).toHaveLength(1);
      expect(WebAssembly.Module.customSections(module, "bun-wasm-pair")).toEqual([expected.buffer]);
    });
  });

  test(`${label} checks the exact prepared and adopted side without another compile`, async () => {
    const pair = initializationPair(kind, shared);
    const sideHash = digest(pair.side);
    await preparingOnly(async calls => {
      const { plan } = await engineLinkPlan(pair);
      const count = calls.length;
      const side = plan.memberModule(kind);
      expect(plan.memberModule(kind)).toBe(side);
      expect(adoptLinkPlan(plan.shared).memberModule(kind)).toBe(side);
      expect(calls.filter(hash => hash === sideHash)).toHaveLength(1);
      expect(calls).toHaveLength(count);
    });
  });

  for (const profile of ["missing-run", "contradictory", "paired"] as const) {
    test(`${label} refuses ${profile} before returning a program`, async () => {
      const pair = initializationPair(kind, shared, profile);
      const message = profile === "missing-run" ? "initializer/RUN" : profile === "contradictory" ? "Contradictory" : "companion cannot be a paired core";
      await preparingOnly(async (calls, modules) => {
        const pending = prepareProgram(pair);
        await expect(pending).rejects.toThrow(message);
        expect(calls.filter(hash => hash === digest(pair.side))).toHaveLength(1);
        await expect(pending).rejects.toBeInstanceOf(BunWasmAssetError);
        const core = modules.find(module => WebAssembly.Module.customSections(module, "bun-wasm-pair").length > 0);
        expect(core).toBeDefined();
        if (!core) throw new Error("Missing prepared core in rejection control");
        expect(() => programMetadata(core)).toThrow("matching prepared side module");
      });
    });
  }

  test(`${label} still rejects wrong core, wrong side, mixed profiles and malformed bytes`, async () => {
    const pair = initializationPair(kind, shared);
    const other = initializationPair(kind === "jsc" ? "quickjs" : "jsc", shared);
    const opposite = initializationPair(kind, !shared);
    await preparingOnly(async () => {
      await expect(prepareProgram({ ...pair, core: other.core })).rejects.toThrow("core declaration");
      await expect(prepareProgram({ ...pair, side: other.side })).rejects.toThrow(`export ${kind}_initialize_memory`);
      await expect(prepareProgram({ ...pair, side: opposite.side })).rejects.toThrow("different program profiles");
      await expect(prepareProgram({ ...pair, side: pair.side.slice(0, -1) })).rejects.toThrow();
    });
  });

  test(`${label} pair identity includes the exact original side bytes`, async () => {
    const pair = initializationPair(kind, shared);
    const changed = appendCustomSection(pair.side, "test-identity", new Uint8Array([1]));
    const first = await prepareProgram(pair);
    const second = await prepareProgram({ ...pair, side: changed });
    expect(WebAssembly.Module.customSections(first, "bun-wasm-pair")).not.toEqual(WebAssembly.Module.customSections(second, "bun-wasm-pair"));
  });
}
