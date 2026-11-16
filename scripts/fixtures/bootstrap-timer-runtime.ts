import { existsSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { ImmediateTimers, ImmediateQueueConstructor } from "../../crates/bunwasm-runtime/src/js/immediate_queue-types";

interface TimerRuntime {
  realTimers: ImmediateTimers;
  workerPump?: () => boolean;
  runTimers(): number;
  runTicks(): void;
  loopState(): Record<string, number>;
  require(name: "immediate_queue"): ImmediateQueueConstructor;
}

export function bootstrapTimers() {
  const directory = new URL("../../crates/bunwasm-runtime/src/js/", import.meta.url);
  const realm = createContext({});
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let now = 0, context: unknown;
  let fault: (() => void) | undefined;
  let runtime: TimerRuntime;
  function loadPolyfill(name: string) {
    const typed = new URL(`${name}.ts`, directory);
    const path = existsSync(typed) ? typed : new URL(`${name}.js`, directory);
    const source = readFileSync(path, "utf8");
    const code = path.pathname.endsWith(".ts") ? transpiler.transformSync(`globalThis.__factory = ${source}`) : source;
    return runInContext(code, realm, { filename: path.pathname });
  }
  const native = {
    engine: "test", platformInfo: { version: Bun.version, arch: "wasm32" },
    env: () => ({}), argv: () => ["bun"], execArgv: () => [], execPath: () => "/bun",
    cwd: () => "/", hostSignal: () => 0,
    now: () => now,
    getAsyncContext: () => context,
    setAsyncContext: (value: unknown) => { context = value; },
    wake: () => fault?.(),
    scheduleTick: () => queueMicrotask(() => runtime.runTicks()),
    loadPolyfill,
  };
  const source = readFileSync(new URL("bootstrap.js", directory), "utf8");
  const end = source.indexOf("  // --- CommonJS");
  if (end < 0) throw new Error("Missing bootstrap timer-source boundary");
  const prefix = source.slice(0, end) + 'internal.require("process"); return internal; })';
  runtime = runInContext(prefix, realm, { filename: "bun-wasm:bootstrap" })(native);
  return {
    runtime,
    now(value: number) { now = value; },
    context(value: unknown) { context = value; },
    currentContext: () => context,
    wakeFault(value?: () => void) { fault = value; },
  };
}
