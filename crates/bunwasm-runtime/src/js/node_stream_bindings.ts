(function (internal: {
  require(name: "streams"): BunWasm.StreamGlobals;
  require(name: "buffer"): { Buffer: BunWasm.BufferConstructor };
  builtin(name: "node:util/types"): { isAnyArrayBuffer(value: unknown): boolean };
  builtin(name: "node:zlib"): { constants: object };
  native: { readonly engine: "quickjs" | "jsc" | "host" };
}) {
  "use strict";
  type WebStreamState = {
    _state?: string;
    _disturbed?: boolean;
    _closeRequest?: unknown;
    _inFlightCloseRequest?: unknown;
    _readableStreamController?: { error(reason: unknown): void };
    _writableStreamController?: { error(reason: unknown): void };
  };
  type WebStreamConstructor = { readonly prototype: object };
  type WritableState = { closeEmitted?: boolean; emitClose?: boolean; autoDestroy?: boolean };
  type TerminalWritable = {
    _writableState?: WritableState | null;
    destroyed: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    on(event: string, listener: (...args: unknown[]) => void): TerminalWritable;
    once(event: string, listener: (...args: unknown[]) => void): TerminalWritable;
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  type DestroyCallback = { invoke(error?: unknown): void }["invoke"];
  type DestroyReceiver = object;
  type DestroyHook = { invoke(this: DestroyReceiver, error: unknown, callback: DestroyCallback): void }["invoke"];
  type DestroyOptions = { destroy?: DestroyHook | null };
  type StreamBundle = {
    Stream: object;
    errors: { codes: object };
    validators: object;
    utils: object;
    eos: { kEosNodeSynchronousCallback: unknown };
    util: { normalizeEncoding: unknown };
  };
  const streams = internal.require("streams");
  const { Buffer } = internal.require("buffer");
  const pipelineBuffers = Symbol.for("bun-wasm.pipeline.buffers");
  const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
  const errorKey = Symbol.for("nodejs.webstream.controllerErrorFunction");

  function unsupportedState(): Error & { code?: string } {
    const error: Error & { code?: string } = new Error("This host does not expose an unlocked Web Stream's closed promise");
    error.code = "ERR_NOT_SUPPORTED_IN_WASM";
    return error;
  }

  function installWebState(Ctor: WebStreamConstructor, readable: boolean) {
    if (internal.native.engine === "host") {
      if (!(closedKey in Ctor.prototype) || !(errorKey in Ctor.prototype)) throw new Error("The host native-stream bridge is missing");
      return;
    }
    if (!(closedKey in Ctor.prototype)) throw new Error("The portable Web Stream completion hooks are missing");
    if (!(errorKey in Ctor.prototype)) Object.defineProperty(Ctor.prototype, errorKey, { get(this: WebStreamState): (reason: unknown) => void {
      const controller = this._readableStreamController || this._writableStreamController;
      if (!controller) throw unsupportedState();
      return reason => controller.error(reason);
    } });
    const stateName = readable ? "readable" : "writable";
    const symbols: Record<string, (stream: WebStreamState) => unknown> = {
      "nodejs.stream.destroyed": stream => stream._state !== stateName,
      "nodejs.stream.errored": stream => stream._state === "errored" || stream._state === "erroring",
      ["nodejs.stream." + stateName]: stream => stream._state === stateName && (readable || !stream._closeRequest && !stream._inFlightCloseRequest),
    };
    if (readable) symbols["nodejs.stream.disturbed"] = stream => stream._disturbed;
    for (const [name, get] of Object.entries(symbols)) {
      const key = Symbol.for(name);
      if (!(key in Ctor.prototype)) Object.defineProperty(Ctor.prototype, key, { get(this: WebStreamState) { return get(this); } });
    }
  }

  function brand(Ctor: WebStreamConstructor): (value: unknown) => boolean {
    const getter = Object.getOwnPropertyDescriptor(Ctor.prototype, "locked")!.get!;
    return value => { try { Reflect.apply(getter, value, []); return true; } catch { return false; } };
  }

  function observeTerminalWritable(node: TerminalWritable): void {
    const state = node._writableState;
    if (!state || state.closeEmitted || state.emitClose === false) return;
    const pending = node.destroyed || node.writableEnded && !node.writableFinished || node.writableFinished && state.autoDestroy;
    if (!pending) return;
    const error = () => {};
    const cleanup = () => {
      node.removeListener("error", error);
      node.removeListener("close", cleanup);
      node.removeListener("finish", finish);
    };
    const finish = () => { if (!state.autoDestroy && !node.destroyed) cleanup(); };
    node.on("error", error).once("close", cleanup).once("finish", finish);
  }

  function withDestroyHook(node: DestroyReceiver, options: DestroyOptions, callback: DestroyCallback): DestroyCallback {
    const hook = options.destroy;
    if (typeof hook !== "function") return callback;
    return error => {
      try { Reflect.apply(hook, node, [error, callback]); }
      catch (failure) { callback(failure); }
    };
  }

  type PromiseRejection<Result> = { handle(reason: unknown): Result | PromiseLike<Result> }["handle"];
  type StreamBindings<Bundle extends StreamBundle> = BunWasm.StreamGlobals & Bundle & Bundle["Stream"] & Bundle["errors"] & Bundle["errors"]["codes"] & Bundle["validators"] & Bundle["utils"] & {
    Buffer: BunWasm.BufferConstructor;
    TextEncoder: typeof TextEncoder;
    eos: Bundle["eos"];
    kEosNodeSynchronousCallback: Bundle["eos"]["kEosNodeSynchronousCallback"];
    kEmptyObject: object;
    normalizeEncoding: Bundle["util"]["normalizeEncoding"];
    isAnyArrayBuffer(value: unknown): boolean;
    isReadableStream(value: unknown): boolean;
    isWritableStream(value: unknown): boolean;
    zlib: object;
    SafeSet: SetConstructor;
    ArrayPrototypeFilter: <T>(array: T[], callback: (value: T, index: number, array: T[]) => unknown) => T[];
    ObjectKeys: ObjectConstructor["keys"];
    PromisePrototypeThen: <T, TResult1 = T, TResult2 = never>(promise: Promise<T>, resolve?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null, reject?: PromiseRejection<TResult2> | null) => Promise<TResult1 | TResult2>;
    PromiseResolve: PromiseConstructor["resolve"];
    PromiseWithResolvers: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
    SafePromiseAllReturnVoid: <T, U>(items: Iterable<T>, callback: (value: T, index: number) => U) => Promise<void>;
    SafePromisePrototypeFinally: <T>(promise: Promise<T>, callback?: (() => void) | null) => Promise<T>;
    StringPrototypeStartsWith(text: string, prefix: string): boolean;
    TypedArrayPrototypeGetBuffer(value: object): unknown;
    TypedArrayPrototypeGetByteOffset(value: object): unknown;
    TypedArrayPrototypeGetByteLength(value: object): unknown;
    setOwnProperty(object: object, key: PropertyKey, value: unknown): object;
    getDeprecationWarningEmitter(code: string, message: string): () => void;
    withDestroyHook: typeof withDestroyHook;
    observeTerminalWritable: typeof observeTerminalWritable;
    kPipelineBuffers: symbol;
  };

  return {
    create<Bundle extends StreamBundle>(bundle: Bundle): StreamBindings<Bundle> {
      installWebState(streams.ReadableStream, true);
      installWebState(streams.WritableStream, false);
      const typed: object = Object.getPrototypeOf(Uint8Array.prototype);
      const get: (key: string) => (value: object) => unknown = key => value => Reflect.apply(Object.getOwnPropertyDescriptor(typed, key)!.get!, value, []);
      const types = internal.builtin("node:util/types");
      return Object.assign({}, streams, bundle, bundle.Stream, bundle.errors, bundle.errors.codes, bundle.validators, bundle.utils, {
        Buffer,
        TextEncoder,
        eos: bundle.eos,
        kEosNodeSynchronousCallback: bundle.eos.kEosNodeSynchronousCallback,
        kEmptyObject: Object.freeze({ __proto__: null }),
        normalizeEncoding: bundle.util.normalizeEncoding,
        isAnyArrayBuffer: types.isAnyArrayBuffer,
        isReadableStream: brand(streams.ReadableStream),
        isWritableStream: brand(streams.WritableStream),
        zlib: internal.builtin("node:zlib").constants,
        SafeSet: Set,
        ArrayPrototypeFilter: <T>(array: T[], callback: (value: T, index: number, array: T[]) => unknown) => array.filter(callback),
        ObjectKeys: Object.keys,
        PromisePrototypeThen: <T, TResult1 = T, TResult2 = never>(promise: Promise<T>, resolve?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null, reject?: PromiseRejection<TResult2> | null) => promise.then(resolve, reject),
        PromiseResolve: Promise.resolve.bind(Promise),
        PromiseWithResolvers<T>() {
          let resolve!: (value: T | PromiseLike<T>) => void;
          let reject!: (reason?: unknown) => void;
          const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
          return { promise, resolve, reject };
        },
        SafePromiseAllReturnVoid: <T, U>(items: Iterable<T>, callback: (value: T, index: number) => U) => Promise.all(Array.from(items, callback)).then(() => {}),
        SafePromisePrototypeFinally: <T>(promise: Promise<T>, callback?: (() => void) | null) => promise.finally(callback),
        StringPrototypeStartsWith: (text: string, prefix: string) => text.startsWith(prefix),
        TypedArrayPrototypeGetBuffer: get("buffer"),
        TypedArrayPrototypeGetByteOffset: get("byteOffset"),
        TypedArrayPrototypeGetByteLength: get("byteLength"),
        setOwnProperty: (object: object, key: PropertyKey, value: unknown) => Object.defineProperty(object, key, { value, configurable: true, enumerable: true, writable: true }),
        getDeprecationWarningEmitter(code: string, message: string) {
          let warned = false;
          return () => { if (!warned) { warned = true; process.emitWarning!(message, "DeprecationWarning", code); } };
        },
        withDestroyHook,
        observeTerminalWritable,
        kPipelineBuffers: pipelineBuffers,
      });
    },
  };
})
