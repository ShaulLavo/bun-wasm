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
    buffer?: { is(value: unknown): boolean; restore(buffer: ArrayBuffer, offset: number, length: number): Uint8Array };
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
    require(name: "worker_threads"): { initialize(): void };
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
    require(name: "buffer"): { Buffer: {
      from(value: unknown, encoding?: string): Uint8Array;
      from(buffer: ArrayBuffer, offset: number, length: number): Uint8Array;
      isBuffer(value: unknown): boolean;
    } };
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
