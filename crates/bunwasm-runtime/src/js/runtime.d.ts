declare namespace BunWasm {
  interface Native {
    nodePath: {
      resolveWindows(cwd: Uint8Array, paths: Uint8Array[]): Uint8Array;
      lexical(windows: boolean, operation: "isAbsolute", path: Uint8Array): boolean;
      lexical(windows: boolean, operation: "parse", path: Uint8Array): Record<"root" | "dir" | "base" | "ext" | "name", Uint8Array>;
      lexical(windows: boolean, operation: "basename" | "dirname" | "extname" | "normalize", path: Uint8Array, suffix?: Uint8Array): Uint8Array;
      join(windows: boolean, paths: Uint8Array[]): Uint8Array;
      relative(windows: boolean, from: Uint8Array, to: Uint8Array): Uint8Array;
    };
    registerObjectModule(name: string): string;
    clearObjectModules(): void;
    readonly engine: "quickjs" | "jsc" | "host";
    /** Optional slot 18: 0/0 dequeues; modes 0/1/2 publish DEFAULT/IGNORE/HANDLE, 3 raises. */
    hostSignal(signal: number, disposition: number): number;
    globMatch(pattern: string, path: string): boolean;
    globScan(pattern: string, cwd: string, dot: boolean, absolute: boolean, followSymlinks: boolean,
      throwErrorOnBrokenSymlink: boolean, onlyFiles: boolean, followMatchedSymlinks?: boolean): string[];
    getAsyncContext(): unknown;
    runMicrotasks(): void;
    exit(code?: number): never;
  }

  type GlobScanOptions = Parameters<Native["globScan"]> extends [pattern: string, ...options: infer Options] ? Options : never;

  interface Internal {
    readonly native: Native;
    readonly builtinFactories: Record<string, () => object>;
    readonly realTimers: {
      setTimeout(callback: () => void, delay: number): unknown;
      clearTimeout(handle: unknown): void;
      setImmediate(callback: () => void): unknown;
      clearImmediate(handle: unknown): void;
    };
    require(name: "path"): { resolve(...paths: string[]): string; dirname(path: string): string; basename(path: string): string };
    runInContext(context: unknown, callback: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]): unknown;
    handleUncaught(error: unknown): boolean;
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
  interface BufferConstructor {
    from(data: unknown, encodingOrOffset?: string | number, length?: number): BufferBytes;
    isEncoding(encoding: string): boolean;
  }
  interface CompressionTransform extends NodeEmitter {
    readonly destroyed: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly writableLength: number;
    push(chunk: unknown): boolean;
    write(chunk: unknown, encoding?: string | (() => void), callback?: (error?: unknown) => void): boolean;
    end(chunk?: unknown): unknown;
    destroy(error?: unknown): this;
    _read(size: number): void;
    _transform(chunk: unknown, encoding: string, callback: (error?: unknown, result?: unknown) => void): void;
    _flush(callback: (error?: unknown, result?: unknown) => void): void;
    _destroy(error: unknown, callback: (error?: unknown, result?: unknown) => void): void;
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
    /** node:zlib processChunkSync: (data, mode, options JSON, dictionary, flush, chunkSize, maxOutputLength). */
    zlibConvert(data: Uint8Array, mode: string, options?: string, dictionary?: Uint8Array, flush?: number, chunkSize?: number, maxOutputLength?: number): Uint8Array;
    zstdCompress(data: Uint8Array, level: number): Uint8Array;
    zstdDecompress(data: Uint8Array): Uint8Array;
    crc32(data: Uint8Array, initial?: number): number;
    streams: {
      /** A node:zlib native handle: (mode, options JSON, dictionary). */
      codec(mode: string, options?: string, dictionary?: Uint8Array): number;
      /** One codec call into an `outLength` buffer. */
      write(handle: number, data: Uint8Array, flush: number, outLength: number): { bytes: Uint8Array; availIn: number };
      params(handle: number, level: number, strategy: number): void;
      /** Bun's CompressionStreamCoder: (format, decompress, highWaterMark, level). */
      webCodec(format: string, decompress: boolean, highWaterMark: number, level?: number): number;
      webStep(handle: number, data: Uint8Array, finish: boolean): { bytes: Uint8Array; more: boolean };
      push(handle: number, data: Uint8Array, last: boolean): string;
      release(handle: number): void;
    };
    archive: {
      create(entries: [string, Uint8Array][], gzip: boolean, level: number, mtime: number): Uint8Array;
      files(bytes: Uint8Array, patterns: string[]): { name: string; bytes: Uint8Array; mtime: number }[];
      extract(bytes: Uint8Array, path: string, patterns: string[]): number;
    };
  }
  interface Internal {
    /** Short description of a value for ERR_INVALID_ARG_TYPE messages. */
    describe(value: unknown): string;
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
    toUint8(value: ArrayBuffer | ArrayBufferView): Uint8Array;
    concatBytes(chunks: Uint8Array[]): Uint8Array;
    require(name: "buffer"): { Buffer: BufferConstructor; kMaxLength?: number };
    require(name: "bun"): { isMainThread: boolean; write(path: unknown, data: Uint8Array): Promise<number> };
    builtin(name: "node:stream"): {
      Transform: CompressionConstructor;
      Readable: new(options: { read(): void }) => WorkerReadable;
      Writable: new(options: { write(chunk: unknown, encoding: string, callback: (error?: unknown) => void): void; final(callback: () => void): void; destroy?(error: unknown, callback: (error?: unknown) => void): void }) => WorkerWritable;
    };
  }
  interface Internal { web: { Response: { _setUrl(response: Response, url: string): void } } }
  type HTMLHandlerKind = "element" | "comments" | "text" | "doctype" | "end" | "endTag";
  interface HTMLStepEvent { handler: number; kind: HTMLHandlerKind }
  interface HTMLStep { output: Uint8Array; event?: HTMLStepEvent }
  interface HTMLTokenValues {
    tagName: string; setTagName: void; selfClosing: boolean; canHaveContent: boolean; namespaceURI: string;
    removed: boolean; attributes: [string, string][]; getAttribute: string | null; hasAttribute: boolean;
    setAttribute: void; removeAttribute: void; before: void; after: void; replace: void; prepend: void;
    append: void; setInnerContent: void; remove: void; removeAndKeepContent: void; onEndTag: number | undefined;
    text: string; setText: void; lastInTextNode: boolean; name: string | null; setName: void;
    publicId: string | null; systemId: string | null;
  }
  interface Native {
    htmlValidateSelector(selector: string): void;
    htmlCreate(registrations: string): number;
    htmlStep(id: number, action: "write" | "end" | "resume", bytes: Uint8Array): HTMLStep;
    htmlToken<K extends keyof HTMLTokenValues>(id: number, action: K, value: string, html: boolean, extra?: string | number): HTMLTokenValues[K];
    htmlClose(id: number): void;
  }
}

declare namespace BunWasm {
  interface CertificateData {
    raw: Uint8Array;
    subject?: string; issuer?: string;
    subjectEntries: [string, string][]; issuerEntries: [string, string][];
    validFrom: string; validTo: string; serialNumber: string; ca: boolean;
    subjectAltName?: string; infoAccess?: string; keyUsage?: string[];
    signatureAlgorithm: string; signatureAlgorithmOid: string;
    fingerprint: string; fingerprint256: string; fingerprint512: string;
  }
  interface CertificateBuffer extends Uint8Array { toString(encoding?: string): string }
  interface CertificateBufferFactory { from(value: Uint8Array | ArrayBuffer | string, encoding?: string): CertificateBuffer }
  interface CertificateKey {
    readonly type: "public" | "private" | "secret";
    readonly asymmetricKeyDetails?: { modulusLength?: number; namedCurve?: string };
    export(options: { type: "spki"; format: "der" }): CertificateBuffer;
    export(options: { format: "jwk" }): Record<string, string>;
  }
  interface CertificateKeys {
    KeyObject: { new(): CertificateKey };
    createPublicKey(input: CertificateKey | { key: Uint8Array; type: "spki"; format: "der" }): CertificateKey;
  }
  interface Native {
    x509(op: "parse", data: Uint8Array): CertificateData;
    x509(op: "publicKey", data: Uint8Array): Uint8Array;
    x509(op: "checkHost" | "checkEmail" | "checkIP", data: Uint8Array, name: string, flags: number): string | undefined;
    x509(op: "checkIssued" | "verify", data: Uint8Array, other: Uint8Array): boolean;
  }
}
