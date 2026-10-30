// Bun ABI adapters over the runtime's generic handles, rings and network state.
// Guest pointers, native names and slot installation stay on this side of the boundary.
import { memoryViews, type MemoryViews } from "waffle/core";
import { NetHost as RuntimeNetHost } from "waffle/browser/net/host";
import { ERROR, type NetRequest, UNSUPPORTED } from "waffle/browser/net/protocol";
import { SLOT_NAMES, type SlotImpls } from "./trampoline.js";

/** What engine-host.js takes as `net` (see engine-host.d.ts). */
export interface EngineNet {
  natives: Record<string, (...args: never[]) => unknown>;
  caps: Record<string, boolean>;
  onNews(cb: () => void): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export class NetHost {
  private memory!: MemoryViews;
  private host: RuntimeNetHost;

  constructor(
    sab: SharedArrayBuffer,
    send: (msg: NetRequest, transfer?: Transferable[]) => void,
    writeFile?: (path: string, bytes: Uint8Array) => void,
    options?: { shared?: boolean },
  ) {
    this.host = new RuntimeNetHost(sab, send, writeFile, options);
  }

  /** Waffle's host, for notification arming; Bun's ABI stays in this adapter. */
  get runtime(): RuntimeNetHost {
    return this.host;
  }

  attach(memory: WebAssembly.Memory): void {
    this.memory = memoryViews(memory);
  }

  /** Translate Bun's integer/pointer ABI into ordinary strings, bytes and handles. */
  slots(): SlotImpls {
    const slots: SlotImpls = {
      poll: (timeout) => this.host.poll(timeout),
      fetch: (metaPtr, metaLen, bodyPtr, bodyLen) => this.host.fetch(
        this.text(metaPtr, metaLen),
        bodyLen > 0 ? this.bytes(bodyPtr, bodyLen) : null,
      ),
      fetch_head: (handle, ptr, cap) => this.writeResult(this.host.fetchHead(handle), ptr, cap),
      read: (handle, ptr, cap) => {
        const chunk = this.host.read(handle, cap);
        if (typeof chunk === "number") return chunk;
        this.memory.bytes().set(chunk, ptr >>> 0);
        return chunk.length;
      },
      write: (handle, ptr, len) => this.host.write(handle, this.bytes(ptr, len)),
      close: (handle) => this.host.close(handle),
      listen: (hostPtr, hostLen, port) => this.host.listen(this.text(hostPtr, hostLen), port),
      local_port: (handle) => this.host.localPort(handle),
      accept: (listener) => this.host.accept(listener),
      connect: (hostPtr, hostLen, port) => this.host.connect(this.text(hostPtr, hostLen), port),
      error: (handle, ptr, cap) => this.writeResult(this.error(handle), ptr, cap),
      peer_addr: (handle, ptr, cap) => this.writeResult(this.host.peerAddr(handle), ptr, cap),
      shutdown: (handle) => this.host.shutdown(handle),
      local_addr: (handle, ptr, cap) => this.writeResult(this.host.localAddr(handle), ptr, cap),
      listen_path: (ptr, len, flags) => this.pathCall(ptr, len, "listen", flags),
      connect_path: (ptr, len) => this.pathCall(ptr, len, "connect"),
      lookup_start: (hostPtr, hostLen, family, hints) => {
        if (family !== 0 && family !== 4 && family !== 6) return UNSUPPORTED;
        return this.host.lookupStart(this.text(hostPtr, hostLen), { family, hints });
      },
      lookup_head: (handle, ptr, cap) => {
        const result = this.host.lookupHead(handle);
        if (typeof result === "number") return result;
        return this.writeResult(`{"addresses":${decoder.decode(result)}}`, ptr, cap);
      },
    };
    for (const name of SLOT_NAMES) {
      const fn = slots[name];
      if (!fn || name === "error") continue;
      slots[name] = (...args) => { this.pathError = null; return fn(...args); };
    }
    return slots;
  }

  /** Browser-engine native names are Bun policy, not generic network-service names. */
  engineNet(lookup?: (hostname: string, family: 0 | 4 | 6, hints: number) => Promise<{ address: string; family: 4 | 6 }[]>): EngineNet {
    const text = (result: Uint8Array | number) => result instanceof Uint8Array ? decoder.decode(result) : result;
    const slotImpls = this.slots();
    const net: EngineNet = {
      natives: {
        hostPoll: () => UNSUPPORTED,
        hostFetch: (meta: string, body?: Uint8Array) => this.host.fetch(meta, body ?? null),
        hostFetchHead: (handle: number) => text(this.host.fetchHead(handle)),
        hostRead: (handle: number, cap = 65536) => this.host.read(handle, Math.max(1, cap)),
        hostWrite: (handle: number, bytes: Uint8Array) => this.host.write(handle, bytes),
        hostClose: (handle: number) => this.host.close(handle),
        hostListen: (host: string, port: number) => this.host.listen(host, port),
        hostLocalPort: (handle: number) => this.host.localPort(handle),
        hostAccept: (listener: number) => this.host.accept(listener),
        hostConnect: (host: string, port: number) => this.host.connect(host, port),
        hostError: (handle: number) => this.error(handle),
        hostListenPath: (path: string, flags: number) => this.listenPath(path, flags),
        hostConnectPath: (path: string) => { this.pathError = null; return this.host.connectPath(path); },
        hostPeerAddr: (handle: number) => this.host.peerAddr(handle),
        hostShutdown: (handle: number) => this.host.shutdown(handle),
        hostLocalAddr: (handle: number) => this.host.localAddr(handle),
        ...(lookup ? { hostLookup: lookup } : {}),
      },
      caps: Object.fromEntries(SLOT_NAMES.map((name) => [name, name !== "poll" && slotImpls[name] !== undefined])),
      onNews: (cb) => this.host.onNews(cb),
    };
    for (const [name, fn] of Object.entries(net.natives)) {
      if (name === "hostError") continue;
      net.natives[name] = (...args) => { this.pathError = null; return fn(...args); };
    }
    return net;
  }

  private pathError: string | null = null;

  private error(handle: number): string | number {
    return handle === 0 && this.pathError !== null ? this.pathError : this.host.error(handle);
  }

  private invalidPath(syscall: "listen" | "connect"): number {
    this.pathError = JSON.stringify({ name: "Error", message: "Invalid Unix socket path or flags", code: "EINVAL", syscall });
    return ERROR;
  }

  private listenPath(path: string, flags: number): number {
    this.pathError = null;
    if (!Number.isInteger(flags) || flags < 0 || flags > 1) return this.invalidPath("listen");
    return this.host.listenPath(path, { unlinkOnClose: Boolean(flags & 1) });
  }

  private pathCall(ptr: number, len: number, operation: "listen" | "connect", flags = 0): number {
    this.pathError = null;
    let path: string;
    const bytes = this.bytes(ptr, len);
    if (len < 0 || bytes.length !== len) return this.invalidPath(operation);
    try { path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes)); }
    catch { return this.invalidPath(operation); }
    return operation === "listen" ? this.listenPath(path, flags) : this.host.connectPath(path);
  }

  /** TextDecoder requires fixed, unshared storage even when guest memory can grow in place. */
  private text(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(this.bytes(ptr, len)));
  }

  /** Borrow guest bytes for this call only; the generic host copies any outgoing payload. */
  private bytes(ptr: number, len: number): Uint8Array {
    return this.memory.bytes().subarray(ptr >>> 0, (ptr >>> 0) + len);
  }

  /** Bun's sized-result protocol writes only when it fits, but always returns the full length. */
  private writeResult(result: Uint8Array | string | number, ptr: number, cap: number): number {
    if (typeof result === "number") return result;
    const data = typeof result === "string" ? encoder.encode(result) : result;
    if (data.length <= cap) this.memory.bytes().set(data, ptr >>> 0);
    return data.length;
  }
}
