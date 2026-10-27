import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineHostOptions } from "../src/engine-host.js";

export function createNodeAsyncContext(): NonNullable<EngineHostOptions["asyncContext"]> {
  const frames = new AsyncLocalStorage<unknown>();
  return {
    get: () => frames.getStore(),
    set: frame => frames.enterWith(frame),
  };
}
