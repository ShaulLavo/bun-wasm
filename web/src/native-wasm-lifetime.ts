import type { observePromise } from "./promise-reactions.ts";

export function installNativeWasmLifetime(wasm: typeof WebAssembly, track: (promise: Promise<unknown>) => Promise<unknown>, react: typeof observePromise): void {
  for (const name of ["compile", "compileStreaming", "instantiate", "instantiateStreaming"] as const) {
    const operation = wasm[name];
    if (typeof operation !== "function") continue;
    const wrapper = { [name](this: typeof WebAssembly, ...args: unknown[]) {
      const promise: Promise<unknown> = Reflect.apply(operation, this, args);
      return react(track(promise), value => value);
    } }[name];
    Object.defineProperty(wrapper, "length", { value: operation.length });
    Object.defineProperty(wasm, name, { value: wrapper, writable: true, configurable: true });
  }
}
