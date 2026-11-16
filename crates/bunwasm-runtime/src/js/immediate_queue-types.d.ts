export interface ImmediateQueue<T> {
  readonly length: number;
  push(value: T): void;
  pushFront(value: T): void;
  shift(): T | undefined;
}
export interface ImmediateQueueConstructor {
  new<T>(): ImmediateQueue<T>;
  readonly prototype: object;
}
export interface ImmediateTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(callback: () => void): unknown;
  queueSelectedTask(callback: () => void): unknown;
  clearImmediate(handle: unknown): void;
}
declare global {
  namespace BunWasm {
    interface Internal {
      require(name: "immediate_queue"): ImmediateQueueConstructor;
    }
  }
}
