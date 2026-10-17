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
    require(name: "path"): { resolve(...paths: string[]): string; dirname(path: string): string; basename(path: string): string };
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
