export interface Admission {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly expiryReason: unknown;
}

export function admit(admission: Admission): number {
  admission.signal.throwIfAborted();
  const left = admission.deadline - Date.now();
  if (left <= 0) throw admission.expiryReason;
  return left;
}

export function within(admission: Admission, timeoutMs: number, expiryReason: unknown): Admission {
  const deadline = Date.now() + timeoutMs;
  return deadline < admission.deadline ? { signal: admission.signal, deadline, expiryReason } : admission;
}

function settleWithin(admission: Admission, finish: (operation: () => void) => void, operation: () => void, reject: (reason: unknown) => void): void {
  try { admit(admission); finish(operation); }
  catch (error) { finish(() => reject(error)); }
}

/** Stops awaiting without cancelling or forgetting the underlying work. */
export function awaitWithin<T>(work: Promise<T>, admission: Admission): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (operation: () => void) => {
      clearTimeout(timer);
      admission.signal.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => finish(() => reject(admission.signal.reason));
    const settled = (operation: () => void) => settleWithin(admission, finish, operation, reject);
    work.then(value => settled(() => resolve(value)), error => settled(() => reject(error)));
    try {
      const left = admit(admission);
      admission.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(() => reject(admission.expiryReason)), left);
    } catch (error) { finish(() => reject(error)); }
  });
}

export class Scope implements Admission {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly expiryReason: unknown;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly parentAbort: () => void;

  private constructor(timeoutMs: number, parent?: Admission | AbortSignal) {
    const ownDeadline = Date.now() + timeoutMs;
    const inherited = parent && "deadline" in parent && parent.deadline <= ownDeadline ? parent : undefined;
    this.deadline = inherited?.deadline ?? ownDeadline;
    this.expiryReason = inherited?.expiryReason ?? new Error(`Phase timed out after ${timeoutMs} ms`);
    this.signal = this.controller.signal;
    this.parentSignal = parent && ("signal" in parent ? parent.signal : parent);
    this.parentAbort = () => this.close(this.parentSignal?.reason ?? new Error("Matrix interrupted"));
    if (this.parentSignal?.aborted) { this.parentAbort(); return; }
    this.parentSignal?.addEventListener("abort", this.parentAbort, { once: true });
    this.timer = setTimeout(() => this.close(this.expiryReason), Math.max(0, this.deadline - Date.now()));
  }

  static open(timeoutMs: number, parent?: Admission | AbortSignal): Scope { return new Scope(timeoutMs, parent); }

  async run<T>(operation: (admission: Admission) => Promise<T>): Promise<T> {
    admit(this);
    return awaitWithin(operation(this), this);
  }

  close(reason: unknown = new Error("Scope closed")): void {
    if (this.signal.aborted) return;
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener("abort", this.parentAbort);
    this.controller.abort(reason);
  }
}
