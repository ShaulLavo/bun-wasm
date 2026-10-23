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
  interface Emitter {
    _events: Table;
    _eventsCount: number;
    _maxListeners?: number;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    emit(type: Name, ...args: unknown[]): boolean;
    addListener(type: Name, listener: Listener): this;
    on(type: Name, listener: Listener): this;
    prependListener(type: Name, listener: Listener): this;
    once(type: Name, listener: Listener): this;
    prependOnceListener(type: Name, listener: Listener): this;
    removeListener(type: Name, listener: Listener): this;
    off(type: Name, listener: Listener): this;
    removeAllListeners(type?: Name): this;
    listeners(type: Name): Listener[];
    rawListeners(type: Name): Listener[];
    listenerCount(type: Name, listener?: Listener | null): number;
    eventNames(): Name[];
  }
  interface Source extends Partial<Pick<Emitter, "on" | "once" | "removeListener" | "listeners" | "getMaxListeners" | "setMaxListeners" | "listenerCount">> {
    addEventListener?(name: Name, listener: Listener, options: { once?: boolean }): void;
    removeEventListener?(name: Name, listener: Listener, options: { once?: boolean }): void;
  }
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
    (this: Emitter, opts?: Options): void;
    prototype: Emitter;
    init(this: Emitter, opts?: Options): void;
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
    addAbortListener(signal: AbortSignal, listener: Listener): Record<symbol, () => void>;
  }
}

declare namespace BunWasm {
  interface Internal {
    listenerChanged?(target: object, type?: Events.Name): void;
    require(name: "inspect"): { nodeInspect(value: unknown): string };
    require(name: "event_emitter_async_resource"): Events.AsyncConstructor;
  }
}
