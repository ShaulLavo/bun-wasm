(function (internal: {
  native: { env(): Record<string, string>; writeStderr(text: string): void };
  traceExit?: (reason: string, code: number, error?: unknown) => void;
  loopState?: () => Record<string, number>;
}) {
  "use strict";
  const enabled = internal.native.env().BUN_WASM_TRACE_EXIT === "1";
  internal.traceExit = (reason, code, error) => {
    if (!enabled) return;
    let stack: string | null = null;
    try {
      const value = error ?? new Error("Runtime exit");
      if (value !== null && typeof value === "object" && "stack" in value && typeof value.stack === "string") stack = value.stack;
    } catch {
      stack = "<stack unavailable>";
    }
    const record = { reason, code, stack, loop: internal.loopState?.() ?? null };
    internal.native.writeStderr("[bun-wasm:exit] " + JSON.stringify(record) + "\n");
  };
})
