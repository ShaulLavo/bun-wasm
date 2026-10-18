import { readOutcome } from "waffle/proc/outcome";
import { readSync } from "node:fs";
import { DescriptorTable, OpenDescription, type Descriptor, type Resource, type Stream } from "waffle/core/descriptors";
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
    prepareSpawn: () => ({ data: { registry: pipes.registry.handle() } }),
  });
  const isSignalPending = options.isSignalPending ?? createNodeSignalController(client.signals).pending;
  client.installBindings();
  if (client.pid === 1) for (const fd of [0, 1, 2]) {
    if (descriptors.get(fd)) continue;
    const resource = nativeStdio(fd), description = new OpenDescription(resource);
    descriptors.inherit(fd, { description, resource, rightsBase: (fd === 0 ? READ : WRITE) | POLL, rightsInheriting: 0n });
  }
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
      abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid: client.pid, service: client,
        signals: client.signals, wake: client.wake, createPipe: () => client.createPipe() });
      const proc = Object.fromEntries(Object.entries(abi.imports).map(([name, fn]) => [name, guard(fn)]));
      proc.close = fd => descriptors.close(fd!) ? 0 : -8;
      imports.runtime_proc = proc;
      installDescriptors(imports, memory, descriptors, preopenCount, client, isSignalPending, guard);
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
        proc[operation] = (fd, ptr, length) => nativeDescriptor(descriptors.get(fd!)) !== undefined ? -8 : call(fd!, ptr!, length!);
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

type NativeResource = Extract<Resource, { handle: number }> & { nodeWasiFd: number };
function nativeDescriptor(entry: Descriptor | undefined): number | undefined {
  return entry && "nodeWasiFd" in entry.resource ? (entry.resource as NativeResource).nodeWasiFd : undefined;
}

/** One guest namespace owns both process capabilities and private Node WASI handles. Native
 * numbers never escape path_open or enter fd_renumber: even a reused native handle cannot alias
 * a pipe, and closing/replacing a guest binding releases only its own open description. */
function installDescriptors(imports: NodeWasiImports, memory: () => WebAssembly.Memory, descriptors: DescriptorTable,
  preopenCount: number, client: WorkerProcessClient, isSignalPending: () => boolean,
  guard: (fn: (...args: number[]) => number) => (...args: number[]) => number) {
  const wasi = imports.wasi_snapshot_preview1, original = { ...wasi };
  const views = () => memoryViews(memory());
  const native = (fd: number, directory: boolean): NativeResource => directory
    ? { kind: "directory", handle: fd, nodeWasiFd: fd }
    : { kind: "file", handle: fd, nodeWasiFd: fd, offset: 0, append: false };
  const description = (fd: number, directory: boolean) => new OpenDescription(native(fd, directory), () => { original.fd_close!(fd); });
  const all = (1n << 30n) - 1n;
  for (let index = 0; index < preopenCount; index++) {
    const fd = 3 + index, opened = description(fd, true);
    let guest = fd;
    while (descriptors.get(guest)) guest++;
    descriptors.inherit(guest, { description: opened, resource: opened.resource, rightsBase: all, rightsInheriting: all });
  }
  // All descriptor-bearing preview1 calls must translate, including both directory operands
  // of link/rename and the third operand of symlink. Never fall through on a missing guest fd.
  for (const [name, call] of Object.entries(original)) {
    const indices = name === "path_link" ? [0, 4] : name === "path_rename" ? [0, 3] : name === "path_symlink" ? [2]
      : name.startsWith("fd_") || name.startsWith("path_") || name.startsWith("sock_") ? [0] : [];
    if (!indices.length) continue;
    wasi[name] = guard((...args) => {
      for (const index of indices) {
        const fd = nativeDescriptor(descriptors.get(args[index]! >>> 0));
        if (fd === undefined) return 8;
        args[index] = fd;
      }
      return call(...args);
    });
  }
  if (original.path_open) wasi.path_open = guard((...args) => {
    const directory = nativeDescriptor(descriptors.get(args[0]! >>> 0));
    if (directory === undefined) return 8;
    args[0] = directory;
    const result = original.path_open!(...args);
    if (result !== 0) return result;
    const ptr = args[8]!, fd = views().view().getUint32(ptr, true);
    const opened = description(fd, (args[4]! & 2) !== 0);
    try {
      const guest = descriptors.add(opened, { rightsBase: BigInt(args[5]!), rightsInheriting: BigInt(args[6]!) });
      views().view().setUint32(ptr, guest, true);
      return 0;
    } catch (error) { if (!opened.references) original.fd_close!(fd); throw error; }
  });
  for (const operation of ["read", "write"] as const) {
    const name = `fd_${operation}`, call = wasi[name]!;
    wasi[name] = guard((fd, ptr, count, result) => {
      const entry = descriptors.get(fd! >>> 0);
      if (!entry) return 8;
      if (nativeDescriptor(entry) !== undefined) return call(fd!, ptr!, count!, result!);
      if ((entry.rightsBase & (operation === "read" ? READ : WRITE)) === 0n) return 76;
      const resource = entry.resource;
      if (resource.kind !== "pipe" && resource.kind !== "terminal") return 8;
      const view = views().view();
      const chunks = Array.from({ length: count! }, (_, index) => views().range(view.getUint32(ptr! + index * 8, true), view.getUint32(ptr! + index * 8 + 4, true)));
      const bytes = resource[operation](chunks);
      if (bytes < 0) return -bytes;
      views().view().setUint32(result!, bytes, true);
      return 0;
    });
  }
  for (const name of ["fd_fdstat_get", "fd_filestat_get"] as const) {
    const call = wasi[name];
    wasi[name] = guard((fd, ptr) => {
      const entry = descriptors.get(fd! >>> 0);
      if (!entry) return 8;
      if (nativeDescriptor(entry) !== undefined) return call?.(fd!, ptr!) ?? 8;
      const size = name === "fd_fdstat_get" ? 24 : 64;
      views().range(ptr!, size).fill(0);
      const view = views().view(), type = entry.resource.kind === "pipe" ? 6 : 2;
      view.setUint8(ptr! + (name === "fd_fdstat_get" ? 0 : 16), type);
      if (name === "fd_fdstat_get") {
        view.setBigUint64(ptr! + 8, entry.rightsBase, true);
        view.setBigUint64(ptr! + 16, entry.rightsInheriting, true);
      } else view.setBigUint64(ptr! + 24, 1n, true);
      return 0;
    });
  }
  const setRights = wasi.fd_fdstat_set_rights;
  wasi.fd_fdstat_set_rights = guard((fd, base, inheriting) => {
    const entry = descriptors.get(fd! >>> 0);
    if (!entry) return 8;
    const rightsBase = BigInt(base!), rightsInheriting = BigInt(inheriting!);
    if ((entry.rightsBase & rightsBase) !== rightsBase || (entry.rightsInheriting & rightsInheriting) !== rightsInheriting) return 76;
    const result = nativeDescriptor(entry) === undefined ? 0 : setRights?.(fd!, base!, inheriting!) ?? 8;
    if (result === 0) { entry.rightsBase = rightsBase; entry.rightsInheriting = rightsInheriting; }
    return result;
  });
  const setFlags = wasi.fd_fdstat_set_flags;
  wasi.fd_fdstat_set_flags = guard((fd, flags) => {
    const entry = descriptors.get(fd! >>> 0);
    if (!entry) return 8;
    return nativeDescriptor(entry) === undefined ? flags === 0 ? 0 : 58 : setFlags?.(fd!, flags!) ?? 8;
  });
  for (const name of ["fd_seek", "fd_tell", "fd_pread", "fd_pwrite"] as const) {
    const call = wasi[name];
    wasi[name] = guard((fd, ...args) => {
      const entry = descriptors.get(fd! >>> 0);
      if (!entry) return 8;
      return nativeDescriptor(entry) === undefined ? 70 : call?.(fd!, ...args) ?? 8;
    });
  }
  wasi.fd_close = guard(fd => descriptors.close(fd! >>> 0) ? 0 : 8);
  wasi.fd_renumber = guard((from, to) => descriptors.renumber(from! >>> 0, to! >>> 0) ? 0 : 8);
  installPoll(wasi, original.poll_oneoff, memory, descriptors, client, isSignalPending, guard);
}

const monotonicNow = performance.now.bind(performance), realtimeNow = Date.now.bind(Date);
function installPoll(wasi: NodeWasiImports["wasi_snapshot_preview1"], nativePoll: ((...args: number[]) => number) | undefined,
  memory: () => WebAssembly.Memory, descriptors: DescriptorTable, client: WorkerProcessClient, isSignalPending: () => boolean,
  guard: (fn: (...args: number[]) => number) => (...args: number[]) => number) {
  wasi.poll_oneoff = guard((input, output, count, result) => {
    if (!count) return 28;
    if (isSignalPending()) return 27;
    const views = memoryViews(memory());
    views.range(input!, count! * 48); views.range(output!, count! * 32); views.range(result!, 4);
    const initial = views.view();
    const subscriptions = Array.from({ length: count! }, (_, index) => {
      const ptr = input! + index * 48, type = initial.getUint8(ptr + 8), fd = initial.getUint32(ptr + 16, true);
      const delay = Number(initial.getBigUint64(ptr + 24, true)) / 1e6;
      const absolute = (initial.getUint16(ptr + 40, true) & 1) !== 0;
      const clock = initial.getUint32(ptr + 16, true);
      return { ptr, type, fd, userdata: initial.getBigUint64(ptr, true),
        deadline: absolute ? monotonicNow() + delay - (clock === 0 ? realtimeNow() : monotonicNow()) : monotonicNow() + delay };
    });
    if (subscriptions.some(item => item.type > 2)) return 28;
    // Node's native poll retains its own file/clock semantics when no process stream is present.
    if (nativePoll && subscriptions.some(item => item.type !== 0) &&
      subscriptions.every(item => item.type === 0 || nativeDescriptor(descriptors.get(item.fd)) !== undefined)) {
      for (const item of subscriptions) if (item.type !== 0) initial.setUint32(item.ptr + 16, nativeDescriptor(descriptors.get(item.fd))!, true);
      try { return nativePoll(input!, output!, count!, result!); }
      finally { for (const item of subscriptions) if (item.type !== 0) views.view().setUint32(item.ptr + 16, item.fd, true); }
    }
    for (;;) {
      const expected = Atomics.load(client.wake, 0);
      guard(() => 0)();
      if (isSignalPending()) return 27;
      let emitted = 0, timeout = Infinity;
      for (const item of subscriptions) {
        let error = 0, ready = false, nbytes = 0n, hangup = false;
        if (item.type === 0) {
          if (item.fd > 3) { error = 28; ready = true; }
          else {
            const remaining = item.deadline - monotonicNow();
            timeout = Math.min(timeout, remaining); ready = remaining <= 0;
          }
        }
        else {
          const entry = descriptors.get(item.fd);
          if (!entry) { error = 8; ready = true; }
          else if ((entry.rightsBase & POLL) === 0n) { error = 76; ready = true; }
          else if (nativeDescriptor(entry) !== undefined) {
            // Native entries are files/directories from path_open. Ask Node for their actual
            // event metadata even when other subscriptions belong to process streams.
            const at = output! + emitted * 32;
            views.view().setUint32(item.ptr + 16, nativeDescriptor(entry)!, true);
            try { error = nativePoll?.(item.ptr, at, 1, result!) ?? 52; }
            finally { views.view().setUint32(item.ptr + 16, item.fd, true); }
            if (error) return error;
            ready = views.view().getUint32(result!, true) !== 0;
            if (ready) {
              const event = views.view();
              error = event.getUint16(at + 8, true); nbytes = event.getBigUint64(at + 16, true);
              hangup = (event.getUint16(at + 24, true) & 1) !== 0;
            }
          }
          else if (entry.resource.kind === "pipe" || entry.resource.kind === "terminal") {
            const state = entry.resource.readiness();
            ready = item.type === 1 ? state.readable || state.hangup : state.writable || state.hangup;
            hangup = state.hangup; nbytes = item.type === 1 ? BigInt(state.nbytes ?? 0) : 0n;
          } else { error = 8; ready = true; }
        }
        if (!ready) continue;
        const ptr = output! + emitted++ * 32;
        views.range(ptr, 32).fill(0);
        const view = views.view();
        view.setBigUint64(ptr, item.userdata, true); view.setUint16(ptr + 8, error, true); view.setUint8(ptr + 10, item.type);
        view.setBigUint64(ptr + 16, BigInt(nbytes), true); view.setUint16(ptr + 24, hangup ? 1 : 0, true);
      }
      if (emitted) { views.view().setUint32(result!, emitted, true); return 0; }
      // Pipe endpoints and signal publishers can notify different shared words. Bound the
      // rescan rather than sleeping forever on the process control-plane wake alone.
      Atomics.wait(client.wake, 0, expected, Math.max(0, Math.min(timeout, 10)));
    }
  });
}
