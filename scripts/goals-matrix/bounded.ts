export async function bounded<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason ?? new Error("Matrix interrupted"));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error(`Phase timed out after ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
