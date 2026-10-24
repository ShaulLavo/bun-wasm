declare namespace BunWasm {
  type FunctionKind = "normal" | "async" | "generator" | "async-generator";
  interface Native {
    functionImports(args: readonly string[], kind: FunctionKind): number[][];
    resolve(specifier: string, referrer: string, require: boolean): string;
    importModule(path: string): Promise<unknown>;
    utf8Encode(value: string): Uint8Array<ArrayBuffer>;
    nodePath: {
      resolveWindows(cwd: Uint8Array, paths: Uint8Array[]): Uint8Array;
      lexical(windows: boolean, operation: "isAbsolute", path: Uint8Array): boolean;
      lexical(windows: boolean, operation: "parse", path: Uint8Array): Record<"root" | "dir" | "base" | "ext" | "name", Uint8Array>;
      lexical(windows: boolean, operation: "basename" | "dirname" | "extname" | "normalize", path: Uint8Array, suffix?: Uint8Array): Uint8Array;
      join(windows: boolean, paths: Uint8Array[]): Uint8Array;
      relative(windows: boolean, from: Uint8Array, to: Uint8Array): Uint8Array;
    };
    hostLocalAddr(handle: number): string | number;
    hostClose(handle: number): number;
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
    defineGlobal(name: string, value: unknown): void;
    require(name: "builtins"): { "bun:jsc": () => { callerSourceOrigin(): string | null } };
    require(name: "node_url"): { fileURLToPath(url: string | URL): string };
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
  interface AsyncResourceOptions { triggerAsyncId?: number; requireManualDestroy?: boolean }
  interface AsyncResource {
    runInAsyncScope<Args extends unknown[], Result>(callback: (...args: Args) => Result, receiver: unknown, ...args: Args): Result;
    asyncId(): number;
    triggerAsyncId(): number;
    emitDestroy(): this;
  }
  interface Internal {
    builtin(name: "node:async_hooks"): { AsyncResource: { new(type: string, options?: AsyncResourceOptions): AsyncResource } };
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
    require(name: "events"): { new(options?: { captureRejections?: boolean }): NodeEmitter; call(target: object): void; prototype: NodeEmitter };
    require(name: "structured_clone"): { structuredClone(value: unknown, options?: unknown): unknown };
    messagePortRefs: number;
    isMarkedAsUntransferable?: (value: unknown) => boolean;
  }
}

declare var process: { cwd(): string; stdout: BunWasm.WorkerWritable; stderr: BunWasm.WorkerWritable };
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
    concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer>;
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
  type DataFormat = "JSON" | "JSONC" | "JSON5" | "TOML" | "YAML";
  type TestCallback = () => unknown;
  type TestRegistrar = (name: string, callback?: TestCallback, timeout?: number) => unknown;
  type TestHook = (callback: TestCallback, timeout?: number) => unknown;
  interface Native {
    /** `fatal` throws on invalid UTF-8 instead of substituting U+FFFD. */
    utf8Decode(bytes: Uint8Array, fatal?: boolean): string;
  }
  interface Internal {
    require(name: "formats"): { parse(input: unknown, format: DataFormat): unknown };
    require(name: "bun_test"): { exports: {
      test: TestRegistrar & Record<"skip" | "todo" | "only", TestRegistrar>;
      describe(name: string, callback: () => unknown): unknown;
    } & Record<"beforeAll" | "afterAll" | "beforeEach" | "afterEach", TestHook> };
  }
  interface Native {
    /** Host of `http://<domain>/` as the URL crate parses it, or "" when it does not parse. */
    domainToASCII(domain: string): string;
  }
  interface Internal {
    builtin(name: "node:querystring"): { parse(query: string): Record<string, unknown>; stringify(query: object): string };
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

declare function __bunwasm_dynamicImport(from: string): (specifier: string) => Promise<unknown>;
declare namespace BunWasm {
  interface StackFrame { file: string; name: string; line: number; column: number }
  interface ConsoleInspector { parseStack(raw: unknown): StackFrame[] }
  interface StackCallSite {
    getFileName(): string;
    getFunctionName(): string | null;
    getFunction(): unknown;
    getLineNumber(): number;
    getColumnNumber(): number;
    isNative(): boolean;
    isConstructor(): boolean;
    isToplevel(): boolean;
  }
  interface Native {
    bunBuiltinNames(): string[];
    bunBuiltinSource(id: number): string | undefined;
    bunBuiltinHookName(id: number): string;
    bunBuiltinErrorCode(id: number): string;
    evalScript(source: string, filename: string): (intrinsics: Record<string, unknown>) => unknown;
    isPromise(value: unknown): boolean;
    isProxy(value: unknown): boolean;
    isError(value: unknown): boolean;
  }
  interface Internal {
    bunBuiltinGlobals: Record<string, unknown> & {
      Array: ArrayConstructor; Error: ErrorConstructor; Function: FunctionConstructor;
      Map: MapConstructor; Object: ObjectConstructor; Proxy: ProxyConstructor;
      RangeError: RangeErrorConstructor; Reflect: typeof Reflect; Set: SetConstructor;
      String: StringConstructor; Symbol: SymbolConstructor; TypeError: TypeErrorConstructor;
      URIError: URIErrorConstructor;
    };
    builtin(name: string): unknown;
    defineHidden(target: object, values: object): void;
    mappedCallSites: WeakSet<object>;
    formatCallSite(site: StackCallSite): string;
    require(name: "inspect"): ConsoleInspector;
  }
}

interface ErrorConstructor {
  captureStackTrace(target: object, constructorOpt?: Function): void;
  prepareStackTrace: ((target: object, raw: unknown) => unknown) | undefined;
}

declare namespace BunWasm {
  interface FormatTemporalValue {
    toString(options: { calendarName: string; timeZoneName: string }): string;
  }
  interface FormatInstant extends FormatTemporalValue {
    epochNanoseconds: bigint;
    toZonedDateTimeISO(offset: string): FormatTemporalValue;
  }
  interface Native {
    /** Serialized tagged graph from bunwasm-transpiler/src/data.rs. */
    parseData(bytes: Uint8Array, format: DataFormat): string;
  }
  interface Internal {
    require(name: "yaml_coercion"): (value: unknown) => unknown;
    require(name: "formats_limit"): { checkSize(input: { readonly byteLength: number }): void };
    toUint8(value: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array;
  }
}

// Runtime Blob is installed by web.js, with synchronous access to its stored bytes.
interface Blob { _bytes(): Uint8Array }

declare var Bun: {
  inspect(value: unknown): string;
  stringWidth(value: string, options?: { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean }): number;
};
declare var Temporal: {
  Instant: { from(value: string): BunWasm.FormatInstant };
  PlainDate: { from(value: string): BunWasm.FormatTemporalValue };
  PlainDateTime: { from(value: string): BunWasm.FormatTemporalValue };
  PlainTime: { from(value: string): BunWasm.FormatTemporalValue };
  ZonedDateTime: { from(value: string): BunWasm.FormatTemporalValue };
};
