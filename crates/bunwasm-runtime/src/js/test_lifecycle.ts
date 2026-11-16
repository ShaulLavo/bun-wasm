(function () {
  function count(value: unknown, key: string, signature: string) {
    if (value === undefined) return 0;
    if (typeof value !== "number") throw new Error(`${signature}() expects ${key} to be a number`);
    return Number.isNaN(value) ? 0 : Math.min(0xffffffff, Math.max(0, Math.trunc(value)));
  }

  function repeatOptions(options: unknown, signature: string) {
    if (!options || typeof options !== "object") return { retry: 0, repeats: 0 };
    const retry = count(Reflect.get(options, "retry"), "retry", signature);
    const repeatsValue: unknown = Reflect.get(options, "repeats");
    const repeats = count(repeatsValue, "repeats", signature);
    if (retry && repeatsValue !== undefined) throw new Error(`${signature}(): Cannot set both retry and repeats`);
    return { retry, repeats };
  }

  interface Outcome {
    result: { status: string };
    elapsed: number;
    expectCount: number;
  }

  async function attempts<T extends Outcome>(
    policy: { retry: number; repeats: number },
    execute: () => Promise<T>,
    reportFailure: (outcome: T) => void,
  ) {
    let outcome = await execute();
    let retry = 0;
    let repeat = 0;
    let elapsed = outcome.elapsed;
    while (outcome.result.status === "fail" && retry < policy.retry) {
      reportFailure(outcome);
      outcome = await execute();
      elapsed += outcome.elapsed;
      retry++;
    }
    while (outcome.result.status === "pass" && repeat < policy.repeats) {
      outcome = await execute();
      elapsed += outcome.elapsed;
      repeat++;
    }
    const label = retry ? ` (attempt ${retry + 1})` : repeat ? ` (run ${repeat + 1})` : "";
    return { ...outcome, elapsed, label };
  }

  return { repeatOptions, attempts };
})
