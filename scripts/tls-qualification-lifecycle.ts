import type { ProcessRuntime } from "../src/process-runtime.ts";
import { lifecycleObservation } from "./tls-qualification-context.ts";
export class TlsCleanup {
  private readonly closers: Array<() => void | Promise<void>> = [];
  private closing: Promise<void> | undefined;
  add(close: () => void | Promise<void>): void {
    if (this.closing) throw new Error("TLS cleanup already started");
    this.closers.push(close);
  }
  close(): Promise<void> { return this.closing ??= this.drain(); }
  private async drain(): Promise<void> {
    const failures: unknown[] = [];
    for (const close of this.closers.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "TLS cleanup unconfirmed");
  }
}
export async function qualifiedRun<T, R>(validate: () => Promise<T>, setup: (input: T, owner: TlsCleanup) => Promise<R>, exercise: (services: R) => Promise<unknown>, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
  signal.throwIfAborted();
  const input = await validate();
  signal.throwIfAborted();
  const owner = new TlsCleanup();
  let result: unknown;
  try {
    const services = await setup(input, owner);
    signal.throwIfAborted();
    result = await exercise(services);
    signal.throwIfAborted();
  } finally { await owner.close(); }
  signal.throwIfAborted();
  return result;
}
export async function acquireOwned<T>(owner: TlsCleanup, signal: AbortSignal, acquire: () => T | Promise<T>, release: (resource: T) => void | Promise<void>): Promise<T> {
  signal.throwIfAborted();
  const pending = Promise.resolve().then(acquire);
  owner.add(async () => {
    const settled = await Promise.allSettled([pending]);
    const result = settled[0];
    if (result?.status === "fulfilled") await release(result.value);
  });
  const cancelled = new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason ?? new Error("TLS qualification cancelled"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void pending.then(() => signal.removeEventListener("abort", stop), () => signal.removeEventListener("abort", stop));
  });
  const resource = await Promise.race([pending, cancelled]);
  signal.throwIfAborted();
  return resource;
}
export async function closeObservedCase(operations: { dispose(): Promise<void>; close(): Promise<void>; observe(): unknown | Promise<unknown> }) {
  const settled = await Promise.allSettled([Promise.resolve().then(operations.dispose), Promise.resolve().then(operations.close)]);
  const failures = settled.filter(row => row.status === "rejected").map(row => row.reason);
  if (failures.length) throw new AggregateError(failures, "TLS lifecycle cleanup failed");
  return lifecycleObservation(await operations.observe());
}
export function trackCaseRuntime(runtime: ProcessRuntime) {
  const leases = new Set<object>();
  const retainConsumer: ProcessRuntime["retainConsumer"] = consumer => {
    const lease = {};
    const wrapped = { ...consumer, async stop() { await consumer.stop(); leases.delete(lease); } };
    const release = runtime.retainConsumer(wrapped);
    leases.add(lease);
    return () => { release(); leases.delete(lease); };
  };
  const tracked: ProcessRuntime = { ...runtime, get disposed() { return runtime.disposed; }, retainConsumer };
  return { runtime: tracked, liveConsumers: () => leases.size };
}
export async function deadline<T>(operation: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  const cancelled = Promise.withResolvers<never>();
  const stop = () => cancelled.reject(new Error("TLS qualification cancelled"));
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => cancelled.reject(new Error("TLS qualification deadline")), milliseconds);
  if (signal.aborted) stop();
  try { return await Promise.race([operation, cancelled.promise]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}
