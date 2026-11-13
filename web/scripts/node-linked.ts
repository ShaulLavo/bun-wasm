import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WASI } from "node:wasi";
import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { adoptLinkPlan, instantiateLinkPlan, type SharedLinkPlan, type LinkedGroup } from "waffle/link";
import { engineLinkPlan } from "../../src/quickjs-program.ts";
import { programKind, programProfile, type PairedEngine } from "../../src/engine-kind.ts";

export interface NodeProgram {
  readonly module: WebAssembly.Module;
  readonly linkPlan?: SharedLinkPlan;
}

export async function loadNodeProgram(path: string, expected?: PairedEngine): Promise<NodeProgram> {
  const bytes = readFileSync(path);
  const module = await WebAssembly.compile(bytes);
  const kind = programKind(module);
  if (expected !== undefined && kind !== expected) throw new TypeError(`Selected ${expected} core declares ${kind}`);
  if (kind === "single") return { module };
  const side = readFileSync(join(dirname(path), programProfile(kind).side));
  const { plan } = await engineLinkPlan({ kind, core: bytes, side });
  return { module: plan.entryModule, linkPlan: plan.shared };
}

/**
 * Test seam (`--refuse-engine-allocation`): the core's allocator refuses the engine side's first
 * `remaining` requests of `minimumBytes` to `maximumBytes`, as a host that cannot grow memory would.
 */
export interface EngineAllocationFault {
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  remaining: number;
}

export function parseEngineAllocationFault(value: string | undefined): EngineAllocationFault {
  const match = /^(\d+)-(\d+):(\d+)$/.exec(value ?? "");
  if (!match) throw new Error("--refuse-engine-allocation requires MINIMUM-MAXIMUM:COUNT in bytes");
  const [minimumBytes, maximumBytes, remaining] = match.slice(1).map(Number) as [number, number, number];
  if (minimumBytes > maximumBytes) throw new Error("--refuse-engine-allocation requires MINIMUM at or below MAXIMUM");
  return { minimumBytes, maximumBytes, remaining };
}

// The libc allocation imports an engine side takes from its core: requested bytes and the failure result.
const ENOMEM = 48;
const engineAllocators: Record<string, { bytes(args: number[]): number; refused: number }> = {
  malloc: { bytes: ([size = 0]) => size >>> 0, refused: 0 },
  calloc: { bytes: ([count = 0, size = 0]) => (count >>> 0) * (size >>> 0), refused: 0 },
  realloc: { bytes: ([, size = 0]) => size >>> 0, refused: 0 },
  aligned_alloc: { bytes: ([, size = 0]) => size >>> 0, refused: 0 },
  posix_memalign: { bytes: ([, , size = 0]) => size >>> 0, refused: ENOMEM },
};

export function refusingAllocator(name: string, allocate: WebAssembly.ImportValue, fault: EngineAllocationFault): WebAssembly.ImportValue {
  const allocator = engineAllocators[name];
  if (!allocator || typeof allocate !== "function") return allocate;
  return (...args: number[]) => {
    const bytes = allocator.bytes(args);
    if (fault.remaining === 0 || bytes < fault.minimumBytes || bytes > fault.maximumBytes) return allocate(...args);
    fault.remaining--;
    return allocator.refused;
  };
}

// Waffle's link host takes its concrete Wasi type. This bridge supplies only Node's
// existing imports, never the inherited descriptor or filesystem implementation.
class NodeLinkWasi extends Wasi {
  private readonly nativeImports: WebAssembly.Imports;
  private readonly allocationFault: EngineAllocationFault | undefined;
  constructor(nativeImports: WebAssembly.Imports, allocationFault?: EngineAllocationFault) {
    super({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {} });
    this.nativeImports = nativeImports;
    this.allocationFault = allocationFault;
  }
  override imports(module: WebAssembly.Module, bindings?: WebAssembly.Imports): WebAssembly.Imports {
    const imports: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      const namespace = entry.module === "env" || entry.module === "GOT.mem" || entry.module === "GOT.func" ? bindings?.[entry.module] : this.nativeImports[entry.module];
      const value = namespace?.[entry.name];
      if (value === undefined) throw new TypeError(`unsupported import ${entry.module}.${entry.name} (${entry.kind})`);
      const fault = entry.module === "env" ? this.allocationFault : undefined;
      (imports[entry.module] ??= {})[entry.name] = fault ? refusingAllocator(entry.name, value, fault) : value;
    }
    return imports;
  }
}

export async function linkNodeProgram(shared: SharedLinkPlan, imports: WebAssembly.Imports, allocationFault?: EngineAllocationFault): Promise<LinkedGroup> {
  const plan = adoptLinkPlan(shared);
  const wasi = new NodeLinkWasi(imports, allocationFault);
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
