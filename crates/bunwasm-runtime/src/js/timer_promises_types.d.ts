declare namespace BunWasm {
  interface PromiseTimerHandle { unref?(): unknown }
  interface PromiseTimerApi {
    setTimeout(callback: () => void, delay?: number): PromiseTimerHandle;
    clearTimeout(handle: PromiseTimerHandle): void;
    setImmediate(callback: () => void): PromiseTimerHandle;
    clearImmediate(handle: PromiseTimerHandle): void;
  }
}
