import { readSync } from "node:fs";
import { DescriptorTable, OpenDescription, type Stream } from "waffle/core/descriptors";
import { MemFS } from "waffle/fs/memory";
import { memoryViews } from "waffle/core/memory-views";
import { ProcessABI, ProcessSignalExit } from "waffle/proc/abi";
import { WorkerProcessClient, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import type { PipePublicationRegistryHandle } from "waffle/proc/pipes";
import { HOST_CALL_FD, installHostSlotsViaImport, type SlotImpls } from "../src/net/trampoline.ts";
import { writeStdio } from "./node-stdio.ts";
import type { EngineNet } from "../src/net/host.ts";

type HostCall = (slot: number, a: number, b: number, c: number, d: number) => number;
export interface NodeWasiImports {
  wasi_snapshot_preview1: Record<string, (...args: number[]) => number>;
  [namespace: string]: WebAssembly.ModuleImports;
}
const READ = 1n << 1n, WRITE = 1n << 6n, POLL = 1n << 27n;
interface NativeStdio extends Stream { nativeFd: number }

function nativeStdio(fd: number): NativeStdio {
  const read = (chunks: readonly Uint8Array[]) => {
    const bytes = chunks.find(chunk => chunk.length);
    if (!bytes) return 0;
    try { return readSync(fd, bytes); }
    catch (error) { return error instanceof Error && "code" in error && error.code === "EAGAIN" ? -6 : -29; }
  };
  return {
    kind: "terminal", nativeFd: fd, read,
    write: chunks => writeStdio(fd, chunks),
    // Native input is serviced by preview1's blocking fd_read, not a blocking runtime_proc import.
    tryRead: () => -6, tryWrite: chunks => writeStdio(fd, chunks),
    readiness: () => ({ readable: false, writable: fd !== 0, hangup: false }),
  };
}

/** Only explicit native stdio capabilities cross workers; pipes use Waffle's shared codec. */
export const nodeStdioCodec: WorkerDescriptorCodec = {
  export(descriptor) {
    const resource = descriptor.resource;
    if (resource.kind !== "terminal" || !("nativeFd" in resource)) throw new TypeError("unsupported Node process descriptor");
    return { kind: "node-stdio", fd: resource.nativeFd };
  },
  import(value) {
    const token = value as { kind?: string; fd?: number };
    if (token?.kind !== "node-stdio" || !Number.isInteger(token.fd) || token.fd! < 0 || token.fd! > 2) throw new TypeError("invalid Node stdio token");
    return new OpenDescription(nativeStdio(token.fd!));
  },
  discard() {},
};

export interface NodeProcessOptions {
  transport: WorkerProcessTransport;
  registry?: PipePublicationRegistryHandle;
  postMessage(message: WorkerProcessMessage): void;
  finish(code: number, signal?: number): never;
}

/** The Node fixture worker uses the exact same descriptor ABI and service as browser workers. */
export function createNodeProcess(options: NodeProcessOptions) {
  const descriptors = new DescriptorTable();
  const pipes = new WorkerPipeHost({ transport: options.transport, registry: options.registry, postMessage: options.postMessage, fallback: nodeStdioCodec });
  const client = new WorkerProcessClient({
    transport: options.transport, descriptors, codec: pipes.codec(),
    postMessage(message) {
      // Resource limits are Bun worker policy, not part of Waffle's generic SpawnRequest.
      if (message.operation === "spawn" && "worker" in message.request) {
        message.transport.data = { registry: pipes.registry.handle(), worker: message.request.worker };
      }
      options.postMessage(message);
    },
    createPipe: () => pipes.createPipe(), revokeProcess: pid => pipes.revokeProcess(pid),
    prepareSpawn: () => ({ data: { registry: pipes.registry.handle() } }),
  });
  client.installBindings();
  if (client.pid === 1) for (const fd of [0, 1, 2]) {
    if (descriptors.get(fd)) continue;
    const resource = nativeStdio(fd), description = new OpenDescription(resource);
    descriptors.inherit(fd, { description, resource, rightsBase: (fd === 0 ? READ : WRITE) | POLL, rightsInheriting: 0n });
  }
  // Node WASI owns the low descriptor namespace for preopens/opened host files. Process pipe
  // capabilities live above it; preview1 dispatch checks this table before entering Node WASI.
  if (!descriptors.get(65535)) {
    const marker = new OpenDescription(nativeStdio(2));
    descriptors.inherit(65535, { description: marker, resource: marker.resource, rightsBase: 0n, rightsInheriting: 0n });
    descriptors.close(65535);
  }
  let abi: ProcessABI;
  const guard = <T extends (...args: number[]) => number>(fn: T) => (...args: number[]) => {
    try {
      if (Atomics.load(client.signals.outcome, 0) !== 0n) {
        // ProcessABI checks typed default outcomes at signal checkpoints. Never allow guest
        // JS to catch a default action and continue writing inherited native stdio.
        abi.imports.interrupted!();
      }
      return fn(...args);
    } catch (error) {
      if (error instanceof ProcessSignalExit) options.finish(error.status, error.signal);
      throw error;
    }
  };
  return {
    client, descriptors, registry: pipes.registry.handle(),
    install(imports: NodeWasiImports, instance: () => WebAssembly.Instance, fetchCall?: HostCall) {
      const memory = () => {
        const memory = instance().exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
        return memory;
      };
      abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid: client.pid, service: client,
        signals: client.signals, wake: client.wake, createPipe: () => client.createPipe() });
      const proc = Object.fromEntries(Object.entries(abi.imports).map(([name, fn]) => [name, guard(fn)]));
      proc.close = fd => descriptors.close(fd!) ? 0 : -8;
      imports.runtime_proc = proc;
      const original = imports.wasi_snapshot_preview1.sock_send!;
      let dispatch: ReturnType<typeof installHostSlotsViaImport> = null;
      const views = () => memoryViews(memory());
      imports.wasi_snapshot_preview1.sock_send = (fd, packet, count, flags, result) => {
        if (fd !== HOST_CALL_FD) return original(fd!, packet!, count!, flags!, result!);
        const view = views().view();
        const args = [4, 8, 12, 16].map(offset => view.getInt32(packet! + offset, true));
        const value = dispatch?.(view.getInt32(packet!, true), args) ?? -52;
        views().view().setInt32(result!, value, true);
        return 0;
      };
      const fetch = (slot: number) => (...args: number[]) => fetchCall?.(slot, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0) ?? -4;
      const slots: SlotImpls = {
        ...(fetchCall ? { poll: fetch(0), fetch: fetch(1), fetch_head: fetch(2), read: fetch(3), close: fetch(5), error: fetch(10) } : {}),
      };
      installStdio(imports, memory, descriptors, guard);
      return { proc, installSlots() { dispatch = installHostSlotsViaImport(instance(), slots); } };
    },
    engineNet(net?: EngineNet): EngineNet {
      // Rust native marshaling calls runtime_proc directly; the engine loop polls readiness.
      return { natives: net?.natives ?? {}, caps: { ...net?.caps, signal: true, proc_spawn: true }, onNews: notify => net?.onNews(notify) };
    },
    dispose() { descriptors.dispose(); },
  };
}

function installStdio(imports: NodeWasiImports, memory: () => WebAssembly.Memory, descriptors: DescriptorTable, guard: (fn: (...args: number[]) => number) => (...args: number[]) => number) {
  const wasi = imports.wasi_snapshot_preview1;
  for (const operation of ["read", "write"] as const) {
    const name = `fd_${operation}`, original = wasi[name]!;
    wasi[name] = guard((fd, ptr, count, result) => {
      const resource = descriptors.get(fd!)?.resource;
      if (!resource && fd! <= 2) return 8; // Omitted stdio is not implicitly inherited by a child.
      if (!resource || resource.kind === "file" || resource.kind === "directory") return original(fd!, ptr!, count!, result!);
      const views = memoryViews(memory()), view = views.view();
      const chunks = Array.from({ length: count! }, (_, index) => views.range(view.getUint32(ptr! + index * 8, true), view.getUint32(ptr! + index * 8 + 4, true)));
      const bytes = resource[operation](chunks);
      if (bytes < 0) return -bytes;
      views.view().setUint32(result!, bytes, true);
      return 0;
    });
  }
  const close = wasi.fd_close!;
  wasi.fd_close = fd => descriptors.close(fd!) ? 0 : fd! <= 2 ? 8 : close(fd!);
}
