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
    | ["buffer", string, number] | ["view", string, number, number, number]
    | ["error", string, string, string, number] | ["boxed", number]
    | ["port", Omit<PortSnapshot, "queue">, number];
  interface WorkerGraph { root: number; nodes: WorkerNode[]; }
  interface PortTransfer {
    snapshot: PortSnapshot;
    validate(): void;
    commit(): void;
  }
  interface WorkerCodecHooks {
    isPort(value: unknown): boolean;
    prepare(value: unknown): PortTransfer;
    restore(snapshot: PortSnapshot): unknown;
    activate(value: unknown): void;
  }
  interface WorkerCodec {
    prepare(value: unknown, transfer?: unknown, forbidden?: readonly string[]): { graph: WorkerGraph; commit(): void };
    encode(value: unknown, transfer?: unknown, forbidden?: readonly string[]): WorkerGraph;
    decode(value: unknown): unknown;
  }
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
    cwd(): string;
    exit(code?: number): never;
    on(event: string, callback: EventListener): unknown;
  }
  interface Native {
    gc(): void;
    hostCaps: Record<string, boolean>;
    hostSpawn(meta: string): number;
    hostRead(handle: number, capacity?: number): Uint8Array | number;
    hostWrite(handle: number, bytes: Uint8Array): number;
    hostClose(handle: number): number;
    hostChildPipe(handle: number, fd: number): number;
    hostChildWait(handle: number): number;
    hostChildKill(handle: number, signal: number): number;
    hostError(handle: number): string;
    base64Encode(bytes: Uint8Array, url: boolean): string;
    base64Decode(value: string): Uint8Array;
    transferArrayBuffers(buffers: ArrayBuffer[]): void;
    hostPoll(timeout: number): number;
  }
  interface WorkerChannel {
    send(frame: unknown): void;
    drain(): void;
    pump(receive: (frame: unknown) => void): boolean;
    close(): void;
    readonly pending: boolean;
    readonly ended: boolean;
  }
  interface Internal {
    require(name: "process"): GuestProcess;
    require(name: "worker_codec"): { create(hooks: WorkerCodecHooks): WorkerCodec };
    require(name: "worker_channel"): { open(input: number, output: number): WorkerChannel };
    require(name: "worker_threads"): { initialize(): void; Worker: new(filename: unknown, options?: unknown) => ThreadWorker };
    require(name: "net"): unknown;
    require(name: "node_url"): { fileURLToPath(url: URL): string };
    addIoWaiter(waiter: { ref: boolean; step(): boolean | "progress"; fail(error: unknown): void }): unknown;
    workerPump?: () => boolean;
    workerError?: (error: unknown) => void;
    workerExit?: (code: number) => void;
    workerEnvChange?: (key: string, value: string | undefined) => void;
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
  interface WorkerReadable extends NodeEmitter {
    push(chunk: unknown): boolean;
    pipe(target: { write(chunk: unknown): unknown }): unknown;
    destroy(error?: unknown): void;
  }
  interface WorkerWritable extends NodeEmitter {
    write(chunk: unknown): unknown;
    end(): unknown;
  }
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
  }
  interface Internal {
    builtin(name: "node:module"): { createRequire(path: string): (specifier: string) => unknown };
    workerNoWarnings?: boolean;
    builtin(name: "node:stream"): {
      Readable: new(options: { read(): void }) => WorkerReadable;
      Writable: new(options: { write(chunk: unknown, encoding: string, callback: (error?: unknown) => void): void; final(callback: () => void): void }) => WorkerWritable;
    };
    require(name: "buffer"): { Buffer: { from(value: unknown, encoding?: string): Uint8Array & { toString(encoding?: string): string }; isEncoding(encoding: string): boolean } };
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
    require(name: "bun"): { isMainThread: boolean };
    require(name: "web_worker"): { initialize(port: WebParentPort, options: WebWorkerOptions): void };
    randomUUID(): string;
    initImportMeta(meta: object, path: string, main: boolean): void;
    runMain(path: string): unknown;
    importModule(path: string): unknown;
  }
  interface GuestProcess { emit(event: string, value: unknown): boolean; }
}
interface Blob { _bytes(): Uint8Array; }
