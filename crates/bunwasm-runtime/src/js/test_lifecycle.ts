(function () {
  function description(value: unknown, signature: string) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value === "function" && (value.name || /^class\b/.test(Function.prototype.toString.call(value)))) return value.name;
    throw new Error(`${signature}() expects first argument to be a named class, named function, number, or string`);
  }

  function registration(signature: string, name: unknown, fn: unknown) {
    if (typeof name === "function" && (fn === undefined || fn === null)) return { name: "", fn: name };
    if (typeof fn !== "function") {
      throw new Error(`${signature} expects a function as the second argument`);
    }
    return { name: description(name, signature), fn };
  }

  function count(value: unknown, key: string, signature: string) {
    if (value === undefined) return 0;
    if (typeof value !== "number") throw new Error(`${signature}() expects ${key} to be a number`);
    return Number.isNaN(value) ? 0 : Math.min(0xffffffff, Math.max(0, Math.trunc(value)));
  }

  function repeatOptions(options: unknown, signature: string) {
    if (!options || typeof options !== "object") return { retry: 0, repeats: 0 };
    const retry = count(Reflect.get(options, "retry"), "retry", signature);
    const repeatsValue: unknown = Reflect.get(options, "repeats");
    if (retry && repeatsValue !== undefined) throw new Error(`${signature}(): Cannot set both retry and repeats`);
    return { retry, repeats: count(repeatsValue, "repeats", signature) };
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

  return { registration, repeatOptions, attempts };
})
