export interface LockHandle {
  release(): void;
}

export function presenceLockName(workspaceName: string): string {
  return `bun-wasm:workspace:presence:${workspaceName}`;
}

export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Acquires a Web Lock and returns an explicit release handle.
 * Checks `signal?.aborted` immediately inside the Web Lock callback so any late grant
 * is released on the spot before settling.
 */
export function acquireLockHandle(
  name: string,
  options: LockOptions & { locks?: Pick<LockManager, "request"> } = {},
): Promise<LockHandle | null> {
  const locks = options.locks ?? navigator.locks;
  const { locks: _unused, ...lockOptions } = options;
  if (lockOptions.signal?.aborted) {
    return Promise.reject(lockOptions.signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<LockHandle | null>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = locks.request(name, lockOptions, (lock) => {
      if (!lock) {
        done(() => resolve(null));
        return;
      }
      if (lockOptions.signal?.aborted) {
        const reason = lockOptions.signal.reason ?? new DOMException("Aborted", "AbortError");
        done(() => reject(reason));
        return;
      }
      let released = false;
      let releaseHold!: () => void;
      const hold = new Promise<void>((res) => {
        releaseHold = res;
      });
      done(() =>
        resolve({
          release() {
            if (released) return;
            released = true;
            releaseHold();
          },
        }),
      );
      return hold;
    });
    void req.catch((err) => {
      done(() => reject(err));
    });
  });
}
