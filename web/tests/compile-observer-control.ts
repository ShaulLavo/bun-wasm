// Synthetic browser compiler control. It never instantiates or runs a guest.
import { installCompileObserver } from "../src/compile-observer.ts";
import { loadWasm } from "../src/engine-loader.ts";
import { cacheEngine } from "../src/startup-cache.ts";

export async function cachedSingleControl(digest: string): Promise<void> {
  installCompileObserver();
  Reflect.set(globalThis, "__bunwasmBuilds", { "bun-browser.wasm": digest });
  const url = new URL("bun-browser.wasm", location.href).href;
  const response = await fetch(url);
  if (!await cacheEngine(url, digest, response)) throw new Error("compiler control requires its own working cache");
  const loaded = await loadWasm("bun-browser.wasm", () => {});
  if (!(loaded.module instanceof WebAssembly.Module)) throw new Error("compiler control did not compile a module");
}

export async function streamingSingleControl(): Promise<void> {
  installCompileObserver();
  await loadWasm("unfingerprinted.wasm", () => {});
}
