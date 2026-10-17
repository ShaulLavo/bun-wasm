declare namespace BunWasm {
  interface Native {
    readonly engine: "quickjs" | "jsc" | "host";
    /** Optional slot 18: 0/0 dequeues; modes 0/1/2 publish DEFAULT/IGNORE/HANDLE, 3 raises. */
    hostSignal(signal: number, disposition: number): number;
    globMatch(pattern: string, path: string): boolean;
    globScan(pattern: string, cwd: string, dot: boolean, absolute: boolean, followSymlinks: boolean,
      throwErrorOnBrokenSymlink: boolean, onlyFiles: boolean, followMatchedSymlinks?: boolean): string[];
  }

  type GlobScanOptions = Parameters<Native["globScan"]> extends [pattern: string, ...options: infer Options] ? Options : never;

  interface Internal {
    readonly native: Native;
    require(name: "path"): { resolve(...paths: string[]): string };
  }
  type EventListener = (...args: unknown[]) => void;
  interface NodeEmitter {
    on(this: object, event: string | symbol, listener: EventListener): unknown;
    once(this: object, event: string | symbol, listener: EventListener): unknown;
    prependListener(this: object, event: string | symbol, listener: EventListener): unknown;
    prependOnceListener(this: object, event: string | symbol, listener: EventListener): unknown;
    removeListener(this: object, event: string | symbol, listener: EventListener): unknown;
    removeAllListeners(this: object, event?: string | symbol): unknown;
    emit(this: object, event: string | symbol, ...args: unknown[]): boolean;
    listenerCount(this: object, event: string | symbol): number;
    listeners(this: object, event: string | symbol): EventListener[];
    rawListeners(this: object, event: string | symbol): EventListener[];
    eventNames(this: object): (string | symbol)[];
    getMaxListeners(this: object): number;
    setMaxListeners(this: object, count: number): unknown;
  }
  interface Internal {
    require(name: "events"): { new(): NodeEmitter; call(target: object): void; prototype: NodeEmitter };
    require(name: "structured_clone"): { structuredClone(value: unknown, options?: unknown): unknown };
    messagePortRefs: number;
    isMarkedAsUntransferable?: (value: unknown) => boolean;
  }
}

declare const process: { cwd(): string };
declare const Buffer: unknown;
declare function setImmediate(callback: () => void): unknown;

declare namespace BunWasm {
  interface BufferBytes extends Uint8Array { toString(encoding?: string): string }
  interface BufferConstructor { from(data: unknown, encodingOrOffset?: string | number, length?: number): BufferBytes }
  interface CompressionTransform extends NodeEmitter {
    push(chunk: unknown): boolean;
    write(chunk: unknown, callback?: () => void): boolean;
    destroy(error?: unknown): this;
    _transform(chunk: unknown, encoding: string, callback: (error: unknown, result?: unknown) => void): void;
    _flush(callback: (error: unknown, result?: unknown) => void): void;
    _destroy(error: unknown, callback: (error: unknown, result?: unknown) => void): void;
  }
  interface CompressionConstructor { new(options?: object): CompressionTransform }
  interface WorkerReadable extends NodeEmitter {
    push(chunk: unknown): boolean;
    pipe(target: { write(chunk: unknown): unknown }): unknown;
    destroy(error?: unknown): void;
  }
  interface WorkerWritable extends NodeEmitter {
    write(chunk: unknown): unknown;
    end(): unknown;
  }
  interface Native {
    compress(data: Uint8Array, level: number, format: string, parameters?: string): Uint8Array;
    decompress(data: Uint8Array, format: string, maxOutputLength?: number): Uint8Array;
    crc32(data: Uint8Array, initial?: number): number;
    streams: {
      codec(format: string, decompress: boolean, level?: number, parameters?: string): number;
      push(handle: number, data: Uint8Array, last: boolean): Uint8Array;
      release(handle: number): void;
    };
    archive: {
      create(entries: [string, Uint8Array][], gzip: boolean, level: number, mtime: number): Uint8Array;
      files(bytes: Uint8Array, patterns: string[]): { name: string; bytes: Uint8Array; mtime: number }[];
      extract(bytes: Uint8Array, path: string, patterns: string[]): number;
    };
  }
  interface Internal {
    toUint8(value: ArrayBuffer | ArrayBufferView): Uint8Array;
    concatBytes(chunks: Uint8Array[]): Uint8Array;
    require(name: "buffer"): { Buffer: BufferConstructor; kMaxLength?: number };
    require(name: "bun"): { write(path: unknown, data: Uint8Array): Promise<number> };
    builtin(name: "node:stream"): {
      Transform: CompressionConstructor;
      Readable: new(options: { read(): void }) => WorkerReadable;
      Writable: new(options: { write(chunk: unknown, encoding: string, callback: (error?: unknown) => void): void; final(callback: () => void): void }) => WorkerWritable;
    };
  }
}
