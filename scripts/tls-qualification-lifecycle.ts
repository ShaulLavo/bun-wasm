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
export async function qualifiedRun<T, R>(validate: () => Promise<T>, setup: (input: T, owner: TlsCleanup) => Promise<R>, exercise: (services: R) => Promise<unknown>): Promise<unknown> {
  const input = await validate();
  const owner = new TlsCleanup();
  try { return await exercise(await setup(input, owner)); }
  finally { await owner.close(); }
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
