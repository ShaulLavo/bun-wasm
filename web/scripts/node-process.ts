import { readOutcome } from "waffle/proc/outcome";
import { readSync, writeSync } from "node:fs";
import { DescriptorTable, OpenDescription, type Stream } from "waffle/core/descriptors";
import { installNodeWasiDescriptors, nodeWasiDescriptor, type NodeWasiImports } from "waffle/proc/node-wasi";
import { ProcessErrno, ProcessError } from "waffle/proc/types";
import { MemFS } from "waffle/fs/memory";
import { memoryViews } from "waffle/core/memory-views";
import { ProcessABI, ProcessSignalExit } from "waffle/proc/abi";
import { WorkerProcessClient, type WorkerDescriptorCodec, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import type { PipePublicationRegistryHandle } from "waffle/proc/pipes";
import { HOST_CALL_FD, installHostSlotsViaImport, type SlotImpls } from "../src/net/trampoline.ts";
import { writeStdio } from "./node-stdio.ts";
import { createNodeSignalController } from "./node-signals.ts";
import { installNodeLinks, type NodeRealpath } from "./node-links.ts";
import { nodePathProbe } from "./node-probe.ts";
import type { EngineNet } from "../src/net/host.ts";

export type { NodeWasiImports } from "waffle/proc/node-wasi";

type HostCall = (slot: number, a: number, b: number, c: number, d: number) => number;
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
    tryRead: () => -6,
    tryWrite: chunks => {
      const bytes = chunks.find(chunk => chunk.length);
      if (!bytes) return 0;
      try { return writeSync(fd, bytes); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR" ? -6 : code === "EPIPE" ? -64 : -29;
      }
    },
    readiness: () => ({ readable: false, writable: fd !== 0, hangup: false }),
  };
}

/** Only explicit native stdio capabilities cross workers; pipes use Waffle's shared codec. */
export const nodeStdioCodec: WorkerDescriptorCodec = {
  export(descriptor) {
    const resource = descriptor.resource;
    if (resource.kind !== "terminal" || !("nativeFd" in resource) || !Number.isInteger(resource.nativeFd) ||
      (resource.nativeFd as number) < 0 || (resource.nativeFd as number) > 2) throw new ProcessError(ProcessErrno.BADF, "unsupported Node process descriptor");
    return { kind: "node-stdio", fd: resource.nativeFd };
  },
  import(value) {
    const token = value as { kind?: string; fd?: number };
    if (token?.kind !== "node-stdio" || !Number.isInteger(token.fd) || token.fd! < 0 || token.fd! > 2) throw new TypeError("invalid Node stdio token");
    return new OpenDescription(nativeStdio(token.fd!));
  },
  discard() {},
};

/** Worker controls are ordinary child bindings, but must follow the child's real preopens. */
function childControls(transport: WorkerProcessTransport, env: Record<string, string>, preopenCount: number) {
  const text = env.BUNWASM_WORKER_CONTROL;
  if (text === undefined) return { transport, env };
  const control = JSON.parse(text) as { input: number; output: number };
  if (!Number.isInteger(control.input) || !Number.isInteger(control.output) || control.input < 3 || control.output < 3 || control.input === control.output ||
    ![control.input, control.output].every(fd => transport.bindings.some(binding => binding.fd === fd))) {
    throw new ProcessError(ProcessErrno.BADF, "invalid worker control descriptors");
  }
  const used = new Set(transport.bindings.filter(binding => binding.fd !== control.input && binding.fd !== control.output).map(binding => binding.fd));
  // An explicit binding can occupy a preopen's usual number. Reserve the resulting guest
  // preopen locations before selecting controls, so both namespaces remain discoverable.
  let next = 3 + preopenCount;
  for (let index = 0; index < preopenCount; index++) {
    let fd = 3 + index;
    while (used.has(fd)) fd++;
    used.add(fd); next = Math.max(next, fd + 1);
  }
  const allocate = () => { while (used.has(next)) next++; const fd = next++; used.add(fd); return fd; };
  const input = allocate(), output = allocate();
  return {
    transport: { ...transport, bindings: transport.bindings.map(binding => ({ ...binding,
      fd: binding.fd === control.input ? input : binding.fd === control.output ? output : binding.fd })) },
    env: { ...env, BUNWASM_WORKER_CONTROL: JSON.stringify({ input, output }) },
  };
}

export interface NodeProcessOptions {
  transport: WorkerProcessTransport;
  env?: Record<string, string>;
  preopenCount?: number;
  /** Node WASI's preopens (guest path to host directory), to resolve symlinks in the guest namespace. */
  preopens?: Record<string, string>;
  registry?: PipePublicationRegistryHandle;
  isSignalPending?(): boolean;
  postMessage(message: WorkerProcessMessage): void;
  finish(code: number, signal?: number): never;
}

/** The Node fixture worker uses the exact same descriptor ABI and service as browser workers. */
export function createNodeProcess(options: NodeProcessOptions) {
  const preopenCount = options.preopenCount ?? 0;
  const { transport, env } = childControls(options.transport, options.env ?? {}, preopenCount);
  const descriptors = new DescriptorTable();
  const pipes = new WorkerPipeHost({ transport, registry: options.registry, postMessage: options.postMessage, fallback: nodeStdioCodec });
  const client = new WorkerProcessClient({
    transport, descriptors, codec: pipes.codec(),
    postMessage(message) {
      // Resource limits are Bun worker policy, not part of Waffle's generic SpawnRequest.
      if (message.operation === "spawn" && "worker" in message.request) {
        message.transport.data = { registry: pipes.registry.handle(), worker: message.request.worker };
      }
      options.postMessage(message);
    },
    createPipe: () => pipes.createPipe(), revokeProcess: pid => pipes.revokeProcess(pid),
    prepareSpawn(pid) {
      pipes.registry.registerProcess(pid);
      return { data: { registry: pipes.registry.handle() }, cancel: () => pipes.registry.collectProcess(pid) };
    },
  });
  const isSignalPending = options.isSignalPending ?? createNodeSignalController(client.signals).pending;
  client.installBindings();
  if (client.pid === 1) for (const fd of [0, 1, 2]) {
    if (descriptors.get(fd)) continue;
    const resource = nativeStdio(fd), description = new OpenDescription(resource);
    descriptors.inherit(fd, { description, resource, rightsBase: (fd === 0 ? READ : WRITE) | POLL, rightsInheriting: 0n });
  }
  const inherited = descriptors.inheritable();
  let abi: ProcessABI;
  const guard = <T extends (...args: number[]) => number>(fn: T) => (...args: number[]) => {
    try {
      if (readOutcome(client.signals.outcome) !== null) {
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
    client, descriptors, env, registry: pipes.registry.handle(),
    install(imports: NodeWasiImports, instance: () => WebAssembly.Instance, fetchCall?: HostCall) {
      const memory = () => {
        const memory = instance().exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
        return memory;
      };
      abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid: client.pid, processIdentity: client.processIdentity, service: client,
        signals: client.signals, wake: client.wake, createPipe: () => client.createPipe() });
      const proc = Object.fromEntries(Object.entries(abi.imports).map(([name, fn]) => [name, guard(fn)]));
      proc.inherited_fd = guard(index => inherited[index >>> 0] ?? -44);
      proc.close = fd => descriptors.close(fd!) ? 0 : -8;
      imports.runtime_proc = proc;
      imports.bun_package_scripts = { handoff: guard(() => -58) };
      imports.runtime_fs = watchImports(memory, descriptors, guard);
      imports.runtime_fs.path_permissions_get = guard(() => 58);
      imports.runtime_fs.path_probe = guard(nodePathProbe(memory, () => imports.wasi_snapshot_preview1.path_filestat_get as never));
      imports.shell_terminal = {
        inherited_fd: guard(index => index >= 0 && index < 3 ? index : -1),
        columns: guard(() => 80), rows: guard(() => 24), phase: guard(() => 0),
        prompt_names: guard(() => -1), prompt: guard(() => -1), prompt_update: guard(() => -1),
        output_position: guard(() => 0),
      };
      // Waffle captures fd_close for native release, then installs guest close itself.
      // Startup failure can dispose Bun's host before Node WASI binds guest memory.
      const wasi = imports.wasi_snapshot_preview1;
      // Below Waffle's descriptor layer, on Node WASI's own descriptors.
      const realpath = options.preopens ? installNodeLinks(wasi, memory, options.preopens) : undefined;
      imports.runtime_fs.path_realpath = guard(realpathImport(memory, descriptors, realpath));
      wasi.fd_close = allowUnstartedWasiClose(wasi.fd_close!);
      installNodeWasiDescriptors(imports, memory, descriptors, preopenCount, client, isSignalPending, guard);
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
      // Native filesystem handles belong to preview1, not the process service's MemFS.
      for (const operation of ["read", "write"] as const) {
        const call = proc[operation]!;
        proc[operation] = (fd, ptr, length) => nodeWasiDescriptor(descriptors.get(fd!)) !== undefined ? -8 : call(fd!, ptr!, length!);
      }
      return { proc, installSlots() { dispatch = installHostSlotsViaImport(instance(), slots); } };
    },
    engineNet(net?: EngineNet): EngineNet {
      // Rust native marshaling calls runtime_proc directly; the engine loop polls readiness.
      return { natives: net?.natives ?? {}, caps: { ...net?.caps, signal: true, proc_spawn: true }, onNews: notify => net?.onNews(notify) };
    },
    dispose() { descriptors.dispose(); },
  };
}

/** `runtime_fs.path_realpath` (Waffle docs/host-abi.md, "Canonical path query") over Node WASI
 * descriptors: the pathname's exact UTF-8 bytes, disjoint outputs, ENOBUFS with the needed length. */
function realpathImport(memory: () => WebAssembly.Memory, descriptors: DescriptorTable, realpath: NodeRealpath | undefined) {
  const EBADF = 8, EFAULT = 21, EINVAL = 28, ENOBUFS = 42, ENOTSUP = 58;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return (fd: number, pathPtr: number, pathLen: number, bufPtr: number, bufLen: number, usedPtr: number): number => {
    const ptr = pathPtr >>> 0, len = pathLen >>> 0, buf = bufPtr >>> 0, capacity = bufLen >>> 0, used = usedPtr >>> 0;
    const size = memory().buffer.byteLength;
    if (ptr + len > size || buf + capacity > size || used + 4 > size) return EFAULT;
    if (capacity > 0 && buf < used + 4 && used < buf + capacity) return EINVAL;
    let path: string;
    try { path = decoder.decode(new Uint8Array(memory().buffer, ptr, len)); } catch { return EINVAL; }
    if (path.includes("\0")) return EINVAL;
    const nodeFd = nodeWasiDescriptor(descriptors.get(fd >>> 0));
    if (nodeFd === undefined) return EBADF;
    if (!realpath) return ENOTSUP;
    const real = realpath(nodeFd, path);
    if (typeof real === "number") return real;
    const bytes = new TextEncoder().encode(real);
    new DataView(memory().buffer).setUint32(used, bytes.length, true);
    if (bytes.length > capacity) return ENOBUFS;
    new Uint8Array(memory().buffer, buf, bytes.length).set(bytes);
    return 0;
  };
}

function allowUnstartedWasiClose(close: (fd: number) => number) {
  return (fd: number) => {
    try { return close(fd); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_WASI_NOT_STARTED") return 0;
      throw error;
    }
  };
}

/** Waffle's `runtime_fs` watch ABI over this host's descriptor table (adapted from Waffle 0.0.103
 * `Wasi.watchOpen`/`watchRead`; docs/bun-patches/portable-filesystem-watcher.md). Node WASI
 * serves the real filesystem and has no change source, so this host answers as Waffle's Wasi
 * does for a filesystem without `watches`: a valid file or directory reports ENOTSUP, and no
 * watch id ever exists for read or close. */
function watchImports(memory: () => WebAssembly.Memory, descriptors: DescriptorTable,
  guard: (fn: (...args: number[]) => number) => (...args: number[]) => number): WebAssembly.ModuleImports {
  const EAGAIN = 6, EBADF = 8, EFAULT = 21, EINVAL = 28, ENOTSUP = 58;
  const fits = (...ranges: [number, number][]) => ranges.every(([at, length]) => (at >>> 0) + length <= memory().buffer.byteLength);
  const overlap = ([a, aLength]: [number, number], [b, bLength]: [number, number]) =>
    aLength > 0 && bLength > 0 && (a >>> 0) < (b >>> 0) + bLength && (b >>> 0) < (a >>> 0) + aLength;
  return {
    watch_open: guard((fd, flags, out) => {
      if (!fits([out!, 4])) return EFAULT;
      if ((flags! >>> 0) & ~1) return EINVAL;
      const entry = descriptors.get(fd! >>> 0);
      if (!entry) return EBADF;
      return entry.resource.kind === "file" || entry.resource.kind === "directory" ? ENOTSUP : EINVAL;
    }),
    watch_read: guard((_id, buf, len, out) => {
      if (!fits([buf!, len! >>> 0], [out!, 4])) return EFAULT;
      return overlap([buf!, len! >>> 0], [out!, 4]) ? EINVAL : EBADF;
    }),
    // No id ever exists, so nothing is ready: EAGAIN with out_id 0 once the spans are valid.
    watch_next: guard((outId, buf, len, out) => {
      if (!fits([outId!, 4], [buf!, len! >>> 0], [out!, 4])) return EFAULT;
      if (overlap([outId!, 4], [out!, 4]) || overlap([buf!, len! >>> 0], [outId!, 4]) || overlap([buf!, len! >>> 0], [out!, 4])) return EINVAL;
      new DataView(memory().buffer).setUint32(outId! >>> 0, 0, true);
      return EAGAIN;
    }),
    watch_ready: guard(() => 0),
    watch_close: guard(() => EBADF),
  };
}
