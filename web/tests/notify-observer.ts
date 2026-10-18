import { afterAll, mock } from "bun:test";

// Observe the existing public boundary, not mutable globals captured by Waffle.
// Each suite owns its injection and restoration; production has no mutable hook.
const path = Bun.resolveSync("waffle/proc/control", import.meta.dir).replace(/control\.(ts|js)$/, "intrinsics.$1");
const actual = { ...await import(path) };

type Notify = (word: Int32Array | BigInt64Array, index: number, count?: number) => number;

export function createNotifyObserver() {
  const observer: { current?: Notify; notify: Notify } = {
    notify: (...args) => actual.atomicsNotify(...args),
  };
  mock.module(path, () => ({ ...actual,
    atomicsNotify: (...args: Parameters<typeof Atomics.notify>) => (observer.current ?? actual.atomicsNotify)(...args),
  }));
  afterAll(() => { mock.module(path, () => actual); });
  return observer;
}
