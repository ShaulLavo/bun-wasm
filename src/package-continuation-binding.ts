import type { Descriptor, DescriptorTable } from "waffle/core/descriptors";
import type { WorkerBindingsContext, WorkerExecutionContext, WorkerSetupContext } from "waffle/browser/worker";
import { controlLoad } from "waffle/proc/control";
import { SignalDisposition } from "waffle/proc/signals";
import { parsePackagePlan, type PackagePlan } from "./package-continuation-plan.js";

export const PACKAGE_CONTINUATION = "/.bun-wasm/package-continuation";
export const PACKAGE_ADAPTER = "bun:package-continuation";

function originalRoot(table: DescriptorTable, inherited: ReadonlySet<number>): { fd: number; binding: Descriptor } | undefined {
  const binding = table.rootPreopen();
  if (!binding) return;
  for (const fd of inherited) {
    if (table.get(fd) === binding) return { fd, binding };
  }
  for (let fd = 3; table.get(fd) || inherited.has(fd); fd++) {
    if (table.get(fd) === binding) return { fd, binding };
  }
}

/** Captured after inherited bindings. An alias never becomes the original preopen. */
class PackageDescriptors {
  private root: { fd: number; binding: Descriptor } | undefined;

  constructor(private readonly table: DescriptorTable, reserved: ReadonlySet<number>) {
    this.root = originalRoot(table, reserved);
    const close = table.close.bind(table);
    table.close = fd => {
      const result = close(fd);
      if (result && this.root?.fd === fd) this.root = undefined;
      return result;
    };
    const renumber = table.renumber.bind(table);
    table.renumber = (from, to) => {
      const result = renumber(from, to);
      if (result && this.root?.fd === from) this.root.fd = to;
      return result;
    };
  }

  snapshot(): Array<{ parent: number; child: number }> {
    const fds = this.table.inheritable();
    const root = this.root;
    if (root && this.table.get(root.fd) === root.binding && root.binding.resource.kind === "directory" && root.binding.preopen === "/") fds.push(root.fd);
    fds.sort((left, right) => left - right);
    return fds.map(fd => ({ parent: fd, child: fd }));
  }
}

/** Private executor binding. Positive results request scratch bytes; success never returns. */
export function packageBinding(request: { readonly memoryGroup?: unknown; readonly adapter?: string }, hostCallFd: number) {
  let setup: WorkerSetupContext | undefined;
  let bound: WorkerBindingsContext | undefined;
  let execution: WorkerExecutionContext | undefined;
  let descriptors: PackageDescriptors | undefined;
  const decode = new TextDecoder("utf-8", { fatal: true });
  const encode = new TextEncoder();

  function unsupported(): boolean {
    const state = setup?.runtimeState;
    if (!state || state.parentPid <= 0 || request.memoryGroup || request.adapter === "preview1") return true;
    if (setup?.request.filesystem.publication || setup?.request.filesystem.residentPublication) return true;
    return caughtSignals(state.signals.signalState);
  }

  function handoff(ptr: number, length: number, out: number, capacity: number): number {
    if (!setup) throw new Error("Package binding has no executor context");
    setup.checkActive();
    if (unsupported()) return -58;
    if (!execution?.process || !descriptors || bound?.wasi !== execution.wasi) throw new Error("Package binding was not installed");
    const memory = execution.instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) return -58;
    const bytes = new Uint8Array(memory.buffer);
    const input = range(bytes, ptr, length);
    const output = range(bytes, out, capacity);
    if (!input || !output) return -21;
    let plan: PackagePlan;
    // WebIDL TextDecoder rejects the Browser guest's resizable Wasm buffer.
    try { plan = parsePackagePlan(JSON.parse(decode.decode(Uint8Array.from(input)))); }
    catch { return -28; }
    const argv = [PACKAGE_CONTINUATION, JSON.stringify(plan)];
    // No guest callbacks or asynchronous work between census and ordinary exec's transfer.
    const fds = descriptors.snapshot();
    const payload = encode.encode(JSON.stringify({ executable: PACKAGE_CONTINUATION, argv, env: plan.env, cwd: plan.cwd, fds }));
    if (payload.length > capacity) return payload.length;
    output.set(payload);
    setup.checkActive();
    const result = execution.process.imports.exec!(out, payload.length);
    if (result !== -58 && result !== -52) throw new Error(`Package continuation installation failed: WASI errno ${-result}`);
    return result;
  }

  return {
    namespaces(context: WorkerSetupContext) {
      setup = context;
      return { bun_package_scripts: { handoff } };
    },
    imports(context: WorkerBindingsContext) {
      bound = context;
      const reserved = new Set(context.request.runtimeProcess?.bindings.map(binding => binding.fd));
      reserved.add(hostCallFd);
      descriptors = new PackageDescriptors(context.wasi.descriptors, reserved);
    },
    instantiated(context: WorkerExecutionContext) {
      execution = context;
    },
  };
}

function caughtSignals(state: Parameters<typeof controlLoad>[0]): boolean {
  for (let signal = 1; signal <= 64; signal++) {
    if ((controlLoad(state, signal) & 3) === SignalDisposition.HANDLE) return true;
  }
  return false;
}

function range(bytes: Uint8Array, pointer: number, length: number): Uint8Array | undefined {
  const start = pointer >>> 0, size = length >>> 0;
  if (start > bytes.length || size > bytes.length - start) return undefined;
  return bytes.subarray(start, start + size);
}
