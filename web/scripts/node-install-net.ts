// Rust CLI commands run synchronously before the host JS engine starts. Keep
// their fetches on a worker so WASI poll can wait without blocking Node I/O.
import { memoryViews } from "waffle/core/memory-views";
import { MessageChannel, MessagePort, Worker, receiveMessageOnPort, workerData } from "node:worker_threads";
import type { NodeWasiImports } from "./node-process.ts";
import { packageFetch } from "../src/net/package-fetch.ts";

const AGAIN = -2, ERROR = -1, PACKET_LIMIT = 64 * 1024, DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const HOST_CALL_FD = 0x7fffb0b0;
const SLOTS = [0, 1, 2, 3, 5, 10];
const encoder = new TextEncoder(), decoder = new TextDecoder();

type FetchMeta = {
  url: string;
  method: string;
  headers: [string, string][];
  redirect: RequestRedirect;
  credentialPolicy?: "package";
};
type RequestMessage = { kind: "request"; id: number; meta: FetchMeta; body: Uint8Array<ArrayBuffer> };
type ControlMessage = { kind: "ack" | "close"; id: number };
type WorkerMessage = RequestMessage | ControlMessage;
type FetchHead = { status: number; statusText: string; url: string; redirected: boolean; headers: [string, string][] };
type FetchError = { name: string; message: string };
type WorkerPacket =
  | { kind: "head"; id: number; head: FetchHead }
  | { kind: "chunk"; id: number; body: Uint8Array<ArrayBuffer> }
  | { kind: "end"; id: number }
  | { kind: "error"; id: number; error: FetchError };
type InstallWorkerData = { installFetch: true; port: MessagePort; wake: Int32Array };
type PendingRequest = { controller: AbortController; acknowledge?: () => void };
type Completion = { kind: "pending" | "end" } | { kind: "error"; error: FetchError };
type Handle = { head?: FetchHead; packet?: { body: Uint8Array; offset: number }; completion: Completion };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHeaders(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.every(entry => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === "string" && typeof entry[1] === "string");
}

function isFetchMeta(value: unknown): value is FetchMeta {
  return isRecord(value) && typeof value.url === "string" && typeof value.method === "string" && isHeaders(value.headers)
    && (value.redirect === "follow" || value.redirect === "error" || value.redirect === "manual")
    && (value.credentialPolicy === undefined || value.credentialPolicy === "package");
}

function isBody(value: unknown): value is Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isRecord(value) || typeof value.id !== "number") return false;
  if (value.kind === "ack" || value.kind === "close") return true;
  return value.kind === "request" && isFetchMeta(value.meta) && isBody(value.body);
}

function isFetchHead(value: unknown): value is FetchHead {
  return isRecord(value) && typeof value.status === "number" && typeof value.statusText === "string"
    && typeof value.url === "string" && typeof value.redirected === "boolean" && isHeaders(value.headers);
}

function isWorkerPacket(value: unknown): value is WorkerPacket {
  if (!isRecord(value) || typeof value.id !== "number") return false;
  if (value.kind === "head") return isFetchHead(value.head);
  if (value.kind === "chunk") return isBody(value.body) && value.body.length > 0 && value.body.buffer.byteLength <= PACKET_LIMIT;
  if (value.kind === "end") return true;
  return value.kind === "error" && isRecord(value.error)
    && typeof value.error.name === "string" && typeof value.error.message === "string";
}

function isInstallWorkerData(value: unknown): value is InstallWorkerData {
  return isRecord(value) && value.installFetch === true && value.port instanceof MessagePort
    && value.wake instanceof Int32Array && value.wake.length > 0 && value.wake.buffer instanceof SharedArrayBuffer;
}

export function checkedDownloadSize(received: number, added: number): number {
  const size = received + added;
  if (size > DOWNLOAD_LIMIT) throw new Error("Download exceeds 256 MiB limit");
  return size;
}

function notify(wake: Int32Array): void {
  Atomics.add(wake, 0, 1);
  Atomics.notify(wake, 0);
}

function acknowledge(request: PendingRequest): void {
  const resolve = request.acknowledge;
  request.acknowledge = undefined;
  resolve?.();
}

async function pumpBody(response: Response, request: PendingRequest, send: (packet: Uint8Array<ArrayBuffer>) => void): Promise<void> {
  let size = 0;
  for await (const source of response.body ?? []) {
    size = checkedDownloadSize(size, source.length);
    await splitChunk(source, request, send);
  }
}

async function splitChunk(source: Uint8Array, request: PendingRequest, send: (packet: Uint8Array<ArrayBuffer>) => void): Promise<void> {
  for (let offset = 0; offset < source.length; offset += PACKET_LIMIT) {
    request.controller.signal.throwIfAborted();
    const body = new Uint8Array(Math.min(PACKET_LIMIT, source.length - offset));
    body.set(source.subarray(offset, offset + body.length));
    const consumed = new Promise<void>(resolve => { request.acknowledge = resolve; });
    send(body);
    await consumed;
    request.controller.signal.throwIfAborted();
  }
}

function serve({ port, wake }: InstallWorkerData): void {
  const requests = new Map<number, PendingRequest>();
  function send(packet: WorkerPacket, transfer: ArrayBuffer[] = []): void {
    port.postMessage(packet, transfer);
    notify(wake);
  }
  async function fetchRequest(message: RequestMessage): Promise<void> {
    const request: PendingRequest = { controller: new AbortController() };
    requests.set(message.id, request);
    try {
      const fetcher = message.meta.credentialPolicy === "package" ? packageFetch : fetch;
      const response = await fetcher(message.meta.url, {
        method: message.meta.method, headers: message.meta.headers, redirect: message.meta.redirect,
        signal: request.controller.signal, body: message.body.length ? message.body : undefined,
      });
      send({ kind: "head", id: message.id, head: { status: response.status, statusText: response.statusText,
        url: response.url, redirected: response.redirected, headers: Array.from(response.headers) } });
      await pumpBody(response, request, body => send({ kind: "chunk", id: message.id, body }, [body.buffer]));
      send({ kind: "end", id: message.id });
    } catch (error) {
      if (request.controller.signal.aborted) return;
      send({ kind: "error", id: message.id, error: { name: "TypeError", message: error instanceof Error ? error.message : String(error) } });
    } finally {
      requests.delete(message.id);
      acknowledge(request);
    }
  }
  port.on("message", (message: unknown) => {
    if (!isWorkerMessage(message)) return;
    if (message.kind === "request") { void fetchRequest(message); return; }
    const request = requests.get(message.id);
    if (!request) return;
    if (message.kind === "close") { requests.delete(message.id); request.controller.abort(); }
    acknowledge(request);
  });
}

if (isInstallWorkerData(workerData)) serve(workerData);

/** Installs only the synchronous fetch slots; the JS engine keeps node-net.mjs. */
export function installCliFetch(imports: NodeWasiImports, getInstance: () => WebAssembly.Instance, wake: Int32Array = new Int32Array(new SharedArrayBuffer(4))) {
  const { port1, port2 } = new MessageChannel();
  const handles = new Map<number, Handle>();
  let worker: Worker | undefined, failure: FetchError | undefined, memory: ReturnType<typeof memoryViews> | undefined;
  let next = 1, disposed = false;
  const views = () => {
    if (memory) return memory;
    const exported = getInstance().exports.memory;
    if (!(exported instanceof WebAssembly.Memory)) throw new Error("Missing guest memory");
    return memory = memoryViews(exported);
  };
  const bytes = (ptr: number, length: number) => views().range(ptr, length);
  function drain(): boolean {
    let changed = false;
    for (let received; (received = receiveMessageOnPort(port1));) {
      const packet: unknown = received.message;
      if (!isWorkerPacket(packet)) continue;
      const handle = handles.get(packet.id);
      if (!handle) continue;
      changed = true;
      switch (packet.kind) {
        case "head": handle.head = packet.head; break;
        case "chunk": handle.packet = { body: packet.body, offset: 0 }; break;
        case "end": handle.completion = { kind: "end" }; break;
        case "error": handle.completion = { kind: "error", error: packet.error }; break;
      }
    }
    return changed;
  }
  function fail(error: Error): void {
    if (disposed) return;
    drain();
    failure = { name: "TypeError", message: error.message };
    for (const handle of handles.values()) {
      if (handle.completion.kind === "pending") handle.completion = { kind: "error", error: failure };
    }
    notify(wake);
  }
  function start(meta: unknown, body: Uint8Array<ArrayBuffer>): number {
    if (disposed) return ERROR;
    if (!isFetchMeta(meta)) throw new TypeError("Invalid CLI fetch metadata");
    if (!worker) {
      worker = new Worker(new URL(import.meta.url), { workerData: { installFetch: true, port: port2, wake }, transferList: [port2] });
      worker.on("error", fail);
      worker.on("exit", code => fail(new Error(`CLI fetch worker exited (${code})`)));
    }
    const id = next++;
    if (process.env.BUN_WASM_TRACE || process.env.WASI_TRACE) process.stderr.write(`[bun_wasm] fetch(${body.length} body bytes) -> ${id}\n`);
    handles.set(id, { completion: failure ? { kind: "error", error: failure } : { kind: "pending" } });
    if (!failure) port1.postMessage({ kind: "request", id, meta, body } satisfies RequestMessage);
    return id;
  }
  function textResult(value: FetchHead | FetchError | undefined, ptr: number, cap: number): number {
    if (value === undefined) return AGAIN;
    const data = encoder.encode(JSON.stringify(value));
    if (data.length <= cap) bytes(ptr, data.length).set(data);
    return data.length;
  }
  function readBody(handle: Handle, ptr: number, cap: number, id: number): number {
    const packet = handle.packet;
    if (!packet) return handle.completion.kind === "error" ? ERROR : handle.completion.kind === "end" ? 0 : AGAIN;
    const piece = packet.body.subarray(packet.offset, packet.offset + cap);
    bytes(ptr, piece.length).set(piece);
    packet.offset += piece.length;
    if (packet.offset === packet.body.length) {
      handle.packet = undefined;
      port1.postMessage({ kind: "ack", id } satisfies ControlMessage);
    }
    return piece.length;
  }
  function call(slot: number, a: number, b: number, c: number, d: number): number {
    if (slot === 0) {
      if (drain()) return 1;
      const version = Atomics.load(wake, 0);
      if (drain()) return 1;
      Atomics.wait(wake, 0, version, a < 0 ? undefined : a);
      return drain() ? 1 : 0;
    }
    if (slot === 1) return start(JSON.parse(decoder.decode(bytes(a, b))), bytes(c, d).slice());
    drain();
    const handle = handles.get(a);
    if (!handle) return -3;
    const error = handle.completion.kind === "error" ? handle.completion.error : undefined;
    if (slot === 10) return textResult(error, b, c);
    if (slot === 5) { handles.delete(a); port1.postMessage({ kind: "close", id: a } satisfies ControlMessage); return 0; }
    if (slot === 2) return handle.head ? textResult(handle.head, b, c) : error ? ERROR : AGAIN;
    if (slot === 3) return readBody(handle, b, c, a);
    return error ? ERROR : AGAIN;
  }
  const original = imports.wasi_snapshot_preview1.sock_send!;
  imports.wasi_snapshot_preview1.sock_send = (fd, packet, count, flags, result) => {
    if (fd !== HOST_CALL_FD) return original(fd!, packet!, count!, flags!, result!);
    const view = views().view();
    const slot = view.getInt32(packet!, true);
    if (!SLOTS.includes(slot)) return original(fd!, packet!, count!, flags!, result!);
    const value = call(slot, view.getInt32(packet! + 4, true), view.getInt32(packet! + 8, true),
      view.getInt32(packet! + 12, true), view.getInt32(packet! + 16, true));
    views().view().setInt32(result!, value, true);
    return 0;
  };
  return {
    call,
    install() {
      const pointer = getInstance().exports.bun_wasm_host_slots;
      if (typeof pointer !== "function") throw new Error("Missing host slots export");
      const address = pointer();
      const view = views().view();
      for (const slot of SLOTS) view.setUint32(address + 8 + slot * 4, 0xffffffff, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of handles.keys()) port1.postMessage({ kind: "close", id } satisfies ControlMessage);
      handles.clear();
      port1.close();
      if (!worker) port2.close();
      void worker?.terminate();
    },
  };
}
