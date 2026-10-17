import { memoryViews } from "../../runtime/core/memory-views.js";
import type { SubprocessHost } from "../src/subprocess.ts";
import { HOST_CALL_FD, installHostSlotsViaImport, type SlotImpls } from "../src/net/trampoline.ts";

type HostCall = (slot: number, a: number, b: number, c: number, d: number) => number;
interface WasiImports {
  wasi_snapshot_preview1: {
    sock_send(fd: number, packet: number, count: number, flags: number, result: number): number;
  };
}

export function installNodeProcess(imports: WasiImports, instance: () => WebAssembly.Instance, subprocess: SubprocessHost, fetchCall?: HostCall) {
  const original = imports.wasi_snapshot_preview1.sock_send;
  let dispatch: ReturnType<typeof installHostSlotsViaImport> = null;
  let memory: ReturnType<typeof memoryViews> | undefined;
  const views = () => {
    const buffer = instance().exports.memory;
    if (!(buffer instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
    return memory ??= memoryViews(buffer);
  };
  const fetch = (slot: number) => (...args: number[]) => fetchCall?.(slot, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0) ?? -4;
  const network: SlotImpls = fetchCall ? { poll: fetch(0), fetch: fetch(1), fetch_head: fetch(2), read: fetch(3), close: fetch(5), error: fetch(10) } : {};
  imports.wasi_snapshot_preview1.sock_send = (fd, packet, count, flags, result) => {
    if (fd !== HOST_CALL_FD) return original(fd, packet, count, flags, result);
    const view = views().view();
    const args = [4, 8, 12, 16].map(offset => view.getInt32(packet + offset, true));
    const value = dispatch?.(view.getInt32(packet, true), args) ?? -4;
    views().view().setInt32(result, value, true);
    return 0;
  };
  return { install() {
    const buffer = instance().exports.memory;
    if (!(buffer instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
    subprocess.attach(buffer);
    dispatch = installHostSlotsViaImport(instance(), subprocess.slots(network));
  } };
}
