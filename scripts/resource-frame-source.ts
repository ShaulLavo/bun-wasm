import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The shipped resource_frame.ts module for script tests that load runtime modules directly.
// Without a context slot every frame is empty and runs its callbacks as plain calls.
export interface ContextSlot {
  getAsyncContext(): unknown;
  runInContext(context: unknown, fn: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]): unknown;
}

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/resource_frame.ts", import.meta.url), "utf8");
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`));

const noContext: ContextSlot = {
  getAsyncContext: () => undefined,
  runInContext: (_context, fn, receiver, args) => fn.apply(receiver, args),
};

export function resourceFrames(slot: ContextSlot = noContext): unknown {
  return factory({ native: { getAsyncContext: slot.getAsyncContext }, runInContext: slot.runInContext });
}
