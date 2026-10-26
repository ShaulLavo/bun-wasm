import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WASI } from "node:wasi";
import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { instantiateLinkPlan, prepareLinkPlan, type LinkPlanSource, type LinkedGroup } from "waffle/link";
import { quickjsLinkPlan } from "../../src/quickjs-program.ts";

export interface NodeProgram {
  readonly module: WebAssembly.Module;
  readonly linkPlan?: LinkPlanSource;
}

export async function loadNodeProgram(path: string): Promise<NodeProgram> {
  const bytes = readFileSync(path);
  const module = await WebAssembly.compile(bytes);
  if (!WebAssembly.Module.exports(module).some(entry => entry.name === "bun_core_bind_engine")) return { module };
  const plan = await prepareLinkPlan(quickjsLinkPlan(bytes, readFileSync(join(dirname(path), "quickjs.wasm"))));
  return { module: plan.entryModule, linkPlan: plan.toSource() };
}

// Waffle's link host takes its concrete Wasi type. This bridge supplies only Node's
// existing imports, never the inherited descriptor or filesystem implementation.
class NodeLinkWasi extends Wasi {
  private readonly nativeImports: WebAssembly.Imports;
  constructor(nativeImports: WebAssembly.Imports) {
    super({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {} });
    this.nativeImports = nativeImports;
  }
  override imports(module: WebAssembly.Module, bindings?: Parameters<Wasi["imports"]>[1]): WebAssembly.Imports {
    const imports: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      const namespace = entry.module === "env" || entry.module === "GOT.mem" ? bindings?.[entry.module] : this.nativeImports[entry.module];
      const value = namespace?.[entry.name];
      if (value === undefined) throw new TypeError(`unsupported import ${entry.module}.${entry.name} (${entry.kind})`);
      (imports[entry.module] ??= {})[entry.name] = value;
    }
    return imports;
  }
}

export async function linkNodeProgram(source: LinkPlanSource, imports: WebAssembly.Imports): Promise<LinkedGroup> {
  const plan = await prepareLinkPlan(source);
  const wasi = new NodeLinkWasi(imports);
  try {
    const group = instantiateLinkPlan(plan, { wasi, coreImports: imports, checkActive() {} });
    return { ...group, dispose() { group.dispose(); wasi.descriptors.dispose(); } };
  } catch (error) { wasi.descriptors.dispose(); throw error; }
}

export function startNodeProgram(wasi: WASI, instance: WebAssembly.Instance, linked?: LinkedGroup): number {
  if (!linked) return wasi.start(instance);
  const start = instance.exports._start;
  if (typeof start !== "function") throw new TypeError("linked core must export _start");
  // WASI.start binds Node's native memory before invoking this command entry.
  return wasi.start({ exports: { ...instance.exports, _start() { linked.initialize(); start(); } } });
}
