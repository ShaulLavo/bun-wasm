export const timeoutOptions = {
  "timeout-ms": { type: "string", default: "180000" },
  "build-timeout-ms": { type: "string", default: "300000" },
} as const;

export function acceptanceTimeouts(values: { "timeout-ms"?: string; "build-timeout-ms"?: string }) {
  const read = (name: keyof typeof timeoutOptions) => {
    const value = Number(values[name] ?? timeoutOptions[name].default);
    if (!Number.isSafeInteger(value) || value < 1000 || value > 900000) throw new Error(`Invalid --${name}`);
    return value;
  };
  return { timeoutMs: read("timeout-ms"), buildTimeoutMs: read("build-timeout-ms") };
}

export function acceptanceBudget(phase: string, timeouts: ReturnType<typeof acceptanceTimeouts>) {
  const operationMs = phase === "build" ? timeouts.buildTimeoutMs : timeouts.timeoutMs;
  return { operationMs, watchdogMs: operationMs + 5000 };
}
