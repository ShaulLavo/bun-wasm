import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { runInNewContext } from "node:vm";
import * as util from "node:util";
import { expect } from "bun:test";

const root = new URL("../../../", import.meta.url);
const runtime = new URL("crates/bunwasm-runtime/src/js/", root);
type Done = (error?: Error | null) => void;
export type Socket = import("node:net").Socket & {
  _conn: Raw;
  _phase: string;
  _readableState: { length: number; buffer: { shift(): unknown; length: number } };
  _tlsTransferred?: boolean;
  _tlsTarget?: { host: string; port: number };
};
export type TlsSocket = Omit<Socket, "_conn"> & {
  _conn: Driver;
  encrypted: boolean; authorized: boolean; authorizationError: string | null; servername: string | false; alpnProtocol: string | false;
  secureConnecting: boolean;
  getPeerCertificate(detailed?: boolean): Record<string, unknown>;
  getPeerX509Certificate(): object | undefined;
  getProtocol(): string | null;
  getCipher(): object | undefined;
};
export interface Raw {
  handle: number; closed: boolean; queue: { bytes: Uint8Array; callback?: Done }[];
  ownership: { state: { kind: string; epoch: number }; dispatchDepth: number };
  startReading(): void; write(bytes: Uint8Array, done?: Done): void; destroy(error?: Error): void;
  pumpRead(): boolean | "progress";
  bufferedAmount: number;
}
export interface Driver { closed: boolean; bufferedAmount: number }
export interface Peer {
  protocol: string; cipher: string; alpn: Uint8Array | false;
  verifyResult: number; chainVerified: boolean; authorizationError: string | false; certificates: Uint8Array[];
}
export interface Step {
  kind: "progress" | "wait" | "verification-required" | "failed" | "closed";
  wait?: string; peer?: Peer; error?: { code: string; message: string; libraryCodes: number[] };
  acceptedCiphertext: number; consumedCiphertext: number; acceptedPlaintext: number; committedPlaintext: number;
  pendingPlaintext: number; ciphertext: Uint8Array; plaintext: Uint8Array; ciphertextStart: number; ciphertextEnd: number;
  writeCiphertextEnd?: number; shutdownCiphertextEnd?: number; inputCapacity: number; readClosed: boolean; writeClosed: boolean;
}
export interface Event { kind: string; data?: Uint8Array }
export interface Allowance { plaintext: number; ciphertext: number }
export interface NativeCall { event: Event; allowance: Allowance }
export interface TlsModule {
  connect(...args: unknown[]): TlsSocket;
  TLSSocket: new(socket?: unknown, options?: unknown) => TlsSocket;
  createSecureContext(options?: unknown): object;
  rootCertificates: readonly string[];
  createServer(): unknown;
}
export function adapter() {
  const ticks: (() => void)[] = [];
  const timers = new Set<{ callback: () => void; referenced: boolean; ref(): void; unref(): void }>();
  const immediates: (() => void)[] = [];
  const reads: (Uint8Array | number)[] = [];
  const writes: Uint8Array[] = [];
  const calls: NativeCall[] = [];
  const contexts: object[] = [];
  const releases: [string, number][] = [];
  const connectionOptions: object[] = [];
  const identityRequests: object[] = [];
  const decisions: object[] = [];
  const waiters = new Set<{ ref: boolean; step(): boolean | "progress"; fail?(error: unknown): void; cancel?(): void }>();
  const counters = { opens: 0, closes: 0, shutdowns: 0, reads: 0, warnings: 0, decryptedKeys: 0 };
  const state = { identityTarget: { kind: "dns", hostname: "fixture.test", servername: "" }, credit: Number.MAX_SAFE_INTEGER, tcpReady: true, emitted: 0, accepted: false, insideNative: false, sequence: 0, peer: peer(), legacy: { subjectaltname: "DNS:fixture.test", subject: { CN: "fixture.test" } }, raw: undefined as Raw | undefined };
  let respond = (_event: Event, _allowance: Allowance): Partial<Step> => ({});
  const nextTick = (callback: (...args: unknown[]) => void, ...args: unknown[]) => ticks.push(() => callback(...args));
  const unsupported = (name: string): never => { throw new Error(`Unexpected adapter operation ${name}`); };
  function isWaiter(value: unknown): value is Parameters<typeof waiters.add>[0] {
    if (typeof value !== "object" || value === null || !("ref" in value) || typeof value.ref !== "boolean" || !("step" in value) || typeof value.step !== "function") return false;
    if ("fail" in value && value.fail !== undefined && typeof value.fail !== "function") return false;
    return !("cancel" in value) || value.cancel === undefined || typeof value.cancel === "function";
  }
  class TrackedSet<T> extends Set<T> {
    add(value: T): this {
      if (isWaiter(value)) waiters.add(value);
      return super.add(value);
    }
    delete(value: T): boolean {
      if (isWaiter(value)) waiters.delete(value);
      return super.delete(value);
    }
  }
  const context = { Set: TrackedSet, Buffer, Uint8Array, ArrayBuffer, Error, TypeError, RangeError, AbortController, AbortSignal, TextEncoder, TextDecoder, URL, EventTarget,
    setTimeout(callback: () => void) {
      const timer = { callback, referenced: true, ref() { this.referenced = true; }, unref() { this.referenced = false; } };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer: Parameters<typeof timers.delete>[0]) { timers.delete(timer); }, process: { emitWarning() { counters.warnings++; } } };
  const factories = new Map<string, (internal: unknown) => unknown>();
  function factory(name: string): (internal: unknown) => unknown {
    const cached = factories.get(name);
    if (cached) return cached;
    let source: string;
    const identityPath = process.env.BUN_WASM_TLS_IDENTITY_SOURCE;
    if (name === "tls_identity" && !identityPath) return () => ({
      selectTarget(options: object) { identityRequests.push(structuredClone(options)); return structuredClone(state.identityTarget); },
      checkServerIdentity() { return undefined; },
    });
    if (name === "tls_identity" && identityPath) source = readFileSync(identityPath, "utf8");
    else try { source = readFileSync(new URL(`${name}.ts`, runtime), "utf8"); }
    catch { source = readFileSync(new URL(`${name}.js`, runtime), "utf8"); }
    if (source.includes(": BunWasm.") || name !== "node_stream_core") source = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace("(function", "globalThis.__factory = (function"));
    const loaded = runInNewContext(source, context);
    if (typeof loaded !== "function") throw new Error(`Factory ${name} did not return a function`);
    factories.set(name, loaded);
    return loaded;
  }
  const native = {
    hostCaps: { connect: true, listen: false, fetch: false }, domainToASCII,
    hostConnect(host: string, port: number) { counters.opens++; return host && port ? counters.opens : -1; },
    hostWrite(_handle: number, bytes: Uint8Array) {
      if (!state.tcpReady) return -2;
      if (!bytes.length) return 0;
      if (!state.credit) return -2;
      const count = Math.min(state.credit, bytes.length);
      state.credit -= count;
      writes.push(bytes.slice(0, count));
      return count;
    },
    hostRead(_handle: number, _capacity?: number) { counters.reads++; return reads.shift() ?? -2; },
    hostError: () => JSON.stringify({ code: "ECONNRESET", message: "adapter raw failure" }),
    hostPeerAddr: () => JSON.stringify({ address: "192.0.2.1", port: 443, family: "IPv4" }),
    hostLocalAddr: () => "127.0.0.1:54321",
    hostClose() { counters.closes++; return 0; }, hostShutdown() { counters.shutdowns++; return 0; }, wake() {},
    tlsCreateContext(options: object) { contexts.push(structuredClone(options)); return { id: ++state.sequence, warning: false }; },
    tlsCreateConnection(_id: number, options: object) { connectionOptions.push(structuredClone(options)); return ++state.sequence; },
    tlsRelease(kind: string, id: number) { releases.push([kind, id]); },
    tlsAcceptIdentity(_id: number, decision: { accepted: boolean }) { decisions.push(decision); state.accepted = decision.accepted; },
    tlsInspect() { return { peer: state.peer, authorized: state.peer.chainVerified, authorizationError: state.peer.authorizationError }; },
    tlsStep(_id: number, event: Event, allowance: Allowance): Step {
      state.insideNative = true;
      calls.push({ event: { ...event, data: event.data?.slice() }, allowance: { ...allowance } });
      try {
        const partial = respond(event, allowance);
        const cipher = partial.ciphertext ?? new Uint8Array(0);
        const result: Step = {
          kind: "wait", wait: "ciphertext", acceptedCiphertext: 0, consumedCiphertext: 0, acceptedPlaintext: 0, committedPlaintext: 0,
          pendingPlaintext: 0, ciphertext: cipher, plaintext: new Uint8Array(0), ciphertextStart: state.emitted, ciphertextEnd: state.emitted + cipher.length,
          inputCapacity: 65536, readClosed: false, writeClosed: false, ...partial,
        };
        state.emitted = result.ciphertextEnd;
        return result;
      } finally { state.insideNative = false; }
    },
  };
  const modules = new Map<string, unknown>();
  const stream = objectModule(factory("node_stream_core")({ builtin(name: string) {
    if (name === "node:process") return { nextTick, env: {}, emitWarning() {} };
    if (name === "node:buffer") return { Buffer };
    if (name === "node:events") return EventEmitter;
    if (name === "node:util") return util;
    return unsupported(name);
  } }));
  const internal = {
    pumpIo: () => false, ioPending: () => 0, cancelIoWaiters: () => {},
    native, nextTick, web: { Request, Response, Headers }, builtinFactories: {},
    realTimers: { setImmediate(callback: () => void) { immediates.push(callback); }, clearImmediate() {} },
    addIoWaiter<W extends { ref: boolean; step(): boolean | "progress" }>(waiter: W): W { waiters.add(waiter); return waiter; },
    removeIoWaiter(waiter: Parameters<typeof waiters.delete>[0]) { waiters.delete(waiter); },
    builtin(name: string): unknown {
      if (name === "node:net") return net;
      if (name === "node:stream") return Reflect.get(stream, "Stream");
      if (name === "node:crypto") return {
        X509Certificate: class X509Certificate {
          raw: Uint8Array;
          constructor(bytes: Uint8Array) { this.raw = bytes.slice(); }
          toLegacyObject() { return structuredClone(state.legacy); }
        },
        createPrivateKey() { counters.decryptedKeys++; return { export() { return "DECRYPTED KEY"; } }; },
      };
      return unsupported(name);
    },
    require(name: string): unknown {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "websocket") return { clientClass: () => class {} };
      if (name === "net_address") return { ...objectModule(load(name)), isIP };
      if (name === "http_common") return {};
      return load(name);
    },
  };
  function load(name: string): unknown {
    const loaded = modules.get(name);
    if (loaded !== undefined) return loaded;
    const value = factory(name)(internal);
    modules.set(name, value);
    return value;
  }
  function objectModule(value: unknown): object {
    if (typeof value !== "object" || value === null) throw new Error("Adapter module did not return an object");
    return value;
  }
  const runtimeNet = objectModule(load("net"));
  const netValue = objectModule(Reflect.apply(Reflect.get(runtimeNet, "nodeNet"), runtimeNet, []));
  if (typeof Reflect.get(netValue, "Socket") !== "function" || typeof Reflect.get(netValue, "connect") !== "function") throw new Error("Missing net socket factory");
  const net = netValue as { Socket: new() => Socket; connect(options: object): Socket };
  const tlsValue = objectModule(load("node_tls"));
  for (const key of ["connect", "TLSSocket", "createSecureContext", "createServer"]) if (typeof Reflect.get(tlsValue, key) !== "function") throw new Error(`Missing TLS export ${key}`);
  const tls = tlsValue as TlsModule;
  function callbacks(limit = 256): void {
    for (let count = 0; count < limit && (ticks.length || immediates.length); count++) (ticks.shift() ?? immediates.shift())?.();
    expect(ticks.length + immediates.length).toBe(0);
  }
  function pump(turns = 1): void {
    for (let turn = 0; turn < turns; turn++) internal.pumpIo();
  }
  function plain(connected = true): Socket {
    state.tcpReady = connected;
    const socket: Socket = net.connect({ host: "fixture.test", port: 443 });
    socket.on("error", () => {});
    if (connected) { pump(); callbacks(); }
    state.raw = socket._conn;
    return socket;
  }
  function cancel(): void { internal.cancelIoWaiters(); callbacks(); }
  function cleanup(): void {
    cancel();
    expect(waiters.size).toBe(0);
    expect(timers.size).toBe(0);
    expect(counters.closes).toBe(counters.opens);
    expect(releases.filter(([kind]) => kind === "context")).toHaveLength(contexts.length);
  }
  return { tls, net, native, internal, runtimeNet, state, counters, calls, contexts, releases, decisions, connectionOptions, identityRequests, writes, reads, ticks, immediates, waiters, plain, pump, callbacks, cancel, cleanup,
    timers,
    expireTimers() { for (const timer of Array.from(timers)) { timers.delete(timer); timer.callback(); } },
    respond(handler: (event: Event, allowance: Allowance) => Partial<Step>) { respond = handler; },
    handshake() {
      let announced = false;
      respond = (event: Event): Partial<Step> => {
        if (!announced) { announced = true; return { kind: "verification-required", peer: state.peer }; }
        if (event.kind === "ciphertext") return { kind: "progress", acceptedCiphertext: event.data?.length ?? 0, consumedCiphertext: event.data?.length ?? 0 };
        if (event.kind === "plaintext") return { kind: "progress", acceptedPlaintext: event.data?.length ?? 0, committedPlaintext: event.data?.length ?? 0, ciphertext: event.data ?? new Uint8Array(0), writeCiphertextEnd: state.emitted + (event.data?.length ?? 0) };
        return {};
      };
    },
  };
}
export function peer(): Peer {
  return { protocol: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256", alpn: false, verifyResult: 0, chainVerified: true, authorizationError: false, certificates: [new Uint8Array([1, 2, 3])] };
}
