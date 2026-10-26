declare namespace BunWasm {
  type WorkerRoute = number[];
  interface PortSnapshot {
    id: string;
    peer: string | null;
    version: number;
    sent: number;
    received: number;
    queue: unknown[];
    pending: [number, WorkerGraph][];
    closing: number | null;
    closed: boolean;
  }
  type WorkerNode =
    | ["undefined"] | ["null"] | ["string", string] | ["number", string] | ["boolean", boolean] | ["bigint", string]
    | ["object", [string, number][]] | ["array", number, [string, number][]]
    | ["map", [number, number][]] | ["set", number[]] | ["date", string] | ["regexp", string, string]
    | ["blob", string, string] | ["buffer", string, number] | ["view", string, number, number, number]
    | ["node-buffer", number, number, number] | ["shared", string, number]
    | ["error", string, string, string | null, number] | ["boxed", number]
    | ["port", Omit<PortSnapshot, "queue">, number];
  interface WorkerGraph { root: number; nodes: WorkerNode[]; }
  interface PortTransfer {
    snapshot: PortSnapshot;
    validate(): void;
    commit(): void;
  }
  interface WorkerCodecHooks {
    sharedObjects?: SharedObjects;
    buffer?: { isBuffer(value: unknown): boolean; from(buffer: ArrayBuffer, offset: number, length: number): Uint8Array };
    isPort(value: unknown): boolean;
    prepare(value: unknown): PortTransfer;
    restore(snapshot: PortSnapshot): unknown;
    activate(value: unknown): void;
  }
  interface SharedReference { readonly id: string; readonly byteLength: number; }
  interface SharedPublication {
    reference(buffer: SharedArrayBuffer): SharedReference;
    publish(): void;
    abort(): void;
  }
  interface SharedObjects {
    begin(): SharedPublication;
    read(reference: SharedReference): SharedArrayBuffer;
    wait(references: readonly SharedReference[], ready: () => void): (() => void) | null;
  }
  interface WorkerCodec {
    prepare(value: unknown, transfer?: unknown, forbidden?: readonly string[]): { graph: WorkerGraph; commit(deliver?: () => void): void; abort(): void };
    encode(value: unknown, transfer?: unknown, forbidden?: readonly string[]): WorkerGraph;
    decode(value: unknown): unknown;
    wait(value: unknown, ready: () => void): (() => void) | null;
  }
  interface WorkerErrorData { graph: WorkerGraph; code: unknown; }
  interface WorkerLimits {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  }
  interface GuestProcess {
    env: Record<string, string | undefined>;
    argv: string[];
    execArgv: string[];
    execPath: string;
    exitCode?: number;
    noDeprecation?: boolean;
    cwd(): string;
    exit(code?: number): never;
    on(event: string, callback: EventListener): unknown;
  }
  interface Native {
    sharedObjects?: SharedObjects;
    gc(): void;
    hostCaps: Record<string, boolean>;
    hostRead(handle: number, capacity?: number): Uint8Array | number;
    hostWrite(handle: number, bytes: Uint8Array): number;
    hostClose(handle: number): number;
    hostError(handle: number): string;
    cwd(): string;
    /** Node-style stat record; throws a system error (code ENOENT, ...). */
    stat(path: string, lstat: boolean): { mode: number };
    now(): number;
    /** runtime_proc process ABI. Results are >= 0 or a negative WASI errno (-6 EAGAIN). */
    /** Live executable-access query; the native bridge consumes/cancels its request. */
    procAccess(path: string, cwd: string): number;
    procSpawn(request: string): number;
    procJobOf(pid: number): number;
    procPipe(): [read: number, write: number] | number;
    /** WASI fd_close on a runtime descriptor. */
    procClose(fd: number): number;
    /** Bytes, 0 at end of file, or a negative errno. */
    procRead(fd: number, capacity?: number): Uint8Array | number;
    procWrite(fd: number, bytes: Uint8Array): number;
    /** 0 entered, -6 pending, positive WASI startup errno, -11 canceled, -12 unknown/collected. Non-consuming. */
    procStartStatus(pid: number): number;
    /** [kind, value]: 0 exit, 1 signal, 2 positive WASI startup errno; or a negative errno. */
    procWait(pid: number): [kind: number, code: number] | number;
    /** kind 0: exit code; 1: signal; 2: positive WASI startup errno. Both waits consume. */
    procWaitJob(job: number, flags: number): [kind: number, value: number] | number;
    procKill(pid: number, signal: number): number;
    procKillJob(job: number, signal: number): number;
    /** 16-byte subscriptions in, 16-byte events out. */
    procPoll(subscriptions: Uint8Array, timeoutMs: number): Uint8Array | number;
    base64Encode(bytes: Uint8Array, url: boolean): string;
    base64Decode(value: string): Uint8Array<ArrayBuffer>;
    transferArrayBuffers(buffers: ArrayBuffer[]): void;
    isWasmMemoryBuffer?(value: unknown): boolean;
    hostPoll(timeout: number): number;
  }
  /** `subscriptions` lists what the idle event loop may sleep on (procPoll format); see net.js ioWait. */
  interface IoWaiter {
    ref: boolean;
    step(): boolean | "progress";
    fail(error: unknown): void;
    subscriptions?(): Uint8Array;
  }
  interface WorkerChannel {
    send(frame: unknown): void;
    drain(): void;
    /** What the idle loop sleeps on: the input, plus the output while frames are queued. */
    subscriptions(): Uint8Array;
    pump(receive: (frame: unknown) => void): boolean;
    close(): void;
    readonly pending: boolean;
    readonly ended: boolean;
  }
  interface Internal {
    require(name: "process"): GuestProcess;
    require(name: "worker_codec"): { create(hooks: WorkerCodecHooks): WorkerCodec };
    require(name: "worker_channel"): { open(input: number, output: number): WorkerChannel };
    require(name: "worker_threads"): { isMainThread: boolean; initialize(): void; Worker: new(filename: unknown, options?: unknown) => ThreadWorker };
    require(name: "net"): unknown;
    require(name: "node_url"): { fileURLToPath(url: URL): string };
    addIoWaiter<W extends IoWaiter>(waiter: W): W;
    workerPump?: () => boolean;
    workerError?: (error: unknown) => void;
    workerErrorData?: (error: unknown) => WorkerErrorData;
    workerExit?: (code: number) => void;
    workerEnvChange?: (key: string, value: unknown) => void;
    sharedObjects?: SharedObjects;
    workerStartup?: { readonly ready: Promise<void>; cancel(): void };
    clonePorts?: (value: unknown, options: unknown) => unknown;
    isMessagePort?: (value: unknown) => boolean;
    isProxy?: (value: unknown) => boolean;
    isWasmMemoryBuffer?: (value: unknown) => boolean;
  }
}
interface ArrayBuffer {
  transfer(length?: number): ArrayBuffer;
  readonly resizable: boolean;
  readonly maxByteLength: number;
}
interface ArrayBufferConstructor {
  new(length: number, options?: { maxByteLength?: number }): ArrayBuffer;
}
declare namespace BunWasm {
  interface WorkerChild {
    pid: number;
    readonly signalCode: string | number | null;
    stdin: { write(chunk: unknown): unknown; end(): void } | null;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal: number): boolean;
    ref(): unknown;
    unref(): unknown;
    _finishWorker(): void;
    _abortWorker(): void;
    /** Parent descriptors: `input` is read for frames from the worker, `output` is written to it. */
    _workerChannel: { input: number; output: number };
  }
  interface Internal {
    builtin(name: "node:module"): { createRequire(path: string): (specifier: string) => unknown };
    workerNoWarnings?: boolean;
    require(name: "spawn"): { spawn(argv: string[], options: Record<string, unknown>): WorkerChild };
    require(name: "worker_stdio"): {
      readable(source: ReadableStream<Uint8Array>): { stream: WorkerReadable; drained: Promise<void> };
      writable(sink: { write(chunk: unknown): unknown; end(): void }): WorkerWritable;
    };
  }
  interface GuestProcess {
    stdout: { write(chunk: unknown): unknown };
    stderr: { write(chunk: unknown): unknown };
  }
}

declare namespace BunWasm {
  interface WebWorkerOptions { name: string; preload: string[]; }
  interface WebParentPort extends NodeEmitter, EventTarget {
    start(): void;
    postMessage(value: unknown, transfer?: unknown): void;
  }
  interface ThreadWorker extends NodeEmitter {
    readonly threadId: number;
    postMessage(value: unknown, transfer?: unknown): void;
    ref(): unknown;
    unref(): unknown;
    terminate(): Promise<number | undefined>;
  }
  interface Native {
    resolve(specifier: string, from: string, require: boolean): string;
    workerSource(source: string, path: string): string;
  }
  interface Internal {
    require(name: "web_worker"): { initialize(port: WebParentPort, options: WebWorkerOptions, webMessageEvent: (event: MessageEvent) => MessageEvent): void };
    randomUUID(): string;
    initImportMeta(meta: object, path: string, main: boolean): void;
    runMain(path: string): unknown;
    importModule(path: string): unknown;
  }
  interface GuestProcess { emit(event: string, value: unknown): boolean; }
}
interface Blob { _bytes(): Uint8Array; }
