declare namespace BunWasm.Events {
  type Name = string | symbol;
  interface Listener {
    (this: unknown, ...args: unknown[]): unknown;
    apply(receiver: unknown, args: unknown[] | IArguments): unknown;
    listener?: Listener;
  }
  interface List extends Array<Listener> { warned?: boolean; listener?: Listener }
  type Table = Record<Name, Listener | List | undefined>;
  interface Options { captureRejections?: boolean }
  interface Emit {
    (this: Emitter, type: Name, ...args: unknown[]): boolean;
    apply(receiver: Emitter, args: unknown[]): boolean;
  }
  type Disposable = Partial<Record<symbol, () => void>>;
  interface Emitter {
    _events: Table;
    _eventsCount: number;
    _maxListeners?: number;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    emit: Emit;
    addListener(type: Name, listener: Listener): this;
    on(type: Name, listener: Listener): this;
    prependListener(type: Name, listener: Listener): this;
    once(type: Name, listener: Listener): this;
    prependOnceListener(type: Name, listener: Listener): this;
    removeListener(type: Name, listener: Listener): this;
    off(type: Name, listener: Listener): this;
    removeAllListeners(...args: [] | [Name]): this;
    listeners(type: Name): Listener[];
    rawListeners(type: Name): Listener[];
    listenerCount(type: Name, listener?: Listener | null): number;
    eventNames(): Name[];
  }
  type Prototype = Omit<Emitter, "_events"> & { _events?: Table };
  interface InitialState { _events?: Table; _eventsCount?: number; _maxListeners?: number }
  type EmitterMethods = Pick<Emitter, "on" | "once" | "removeListener">;
  interface TargetMethods {
    addEventListener(name: Name, listener: Listener, options: { once?: boolean; capture?: boolean }): void;
    removeEventListener(name: Name, listener: Listener, options: { once?: boolean; capture?: boolean }): void;
  }
  type Source = Partial<Pick<Emitter, "listeners" | "getMaxListeners" | "setMaxListeners" | "listenerCount">>
    & (EmitterMethods | { on?: undefined; once?: undefined; removeListener?: undefined })
    & (TargetMethods | { addEventListener?: undefined; removeEventListener?: undefined });
  interface OnceState {
    fired: boolean;
    wrapFn: Listener | undefined;
    target: Emitter;
    type: Name;
    listener: Listener;
  }
  interface EventError extends Error { code?: string; context?: unknown }
  interface LeakWarning extends Error { emitter?: Emitter; type?: Name; count?: number }
  type Item = { value: unknown[]; done: false; close?: false } | { value: undefined; done: true; close?: true };
  interface Waiter { resolve(result: Item): void; reject(error: unknown): void }
  interface Iterator {
    next(): Promise<Item>;
    return(): Promise<Item>;
    throw(error: unknown): Promise<never>;
    [Symbol.asyncIterator](): Iterator;
  }
  interface AsyncEmitter extends BunWasm.NodeEmitter {
    readonly asyncId: number;
    readonly triggerAsyncId: number;
    readonly asyncResource: BunWasm.AsyncResource & { readonly eventEmitter: object };
    emitDestroy(): void;
  }
  interface AsyncConstructor {
    new(options?: string | (BunWasm.AsyncResourceOptions & Options & { name?: string })): AsyncEmitter;
  }
  interface Constructor {
    new(opts?: Options): Emitter;
    (this: InitialState, opts?: Options): void;
    prototype: Prototype;
    init(this: InitialState, opts?: Options): void;
    EventEmitter: Constructor;
    usingDomains: boolean;
    captureRejectionSymbol: symbol;
    errorMonitor: symbol;
    kMaxEventTargetListeners: symbol;
    kMaxEventTargetListenersWarned: symbol;
    defaultMaxListeners: number;
    captureRejections: boolean;
    readonly EventEmitterAsyncResource: AsyncConstructor;
    listenerCount(emitter: Emitter, type: Name): number;
    getEventListeners(target: Emitter | EventTarget, type: Name): Listener[];
    getMaxListeners(target: Emitter | EventTarget): number;
    setMaxListeners(n?: number, ...targets: Emitter[]): void;
    once(emitter: Emitter | EventTarget, name: Name, options?: { signal?: AbortSignal }): Promise<unknown[]>;
    on(emitter: Emitter | EventTarget, name: Name, options?: { signal?: AbortSignal; close?: Name[] }): Iterator;
    addAbortListener(signal: AbortSignal, listener: Listener): Disposable;
  }
}

declare namespace BunWasm {
  interface Internal {
    listenerChanged?(target: object, type?: Events.Name): void;
    require(name: "inspect"): { nodeInspect(value: unknown): string };
    require(name: "event_emitter_async_resource"): Events.AsyncConstructor;
  }
}
