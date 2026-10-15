// Types for engine-host.js (plain JS): runs the program in the worker's own JS engine after
// bun-browser.wasm's `_start` returned with `bunwasm_ready() === 1`.

export interface EngineHostOptions {
  /** The bun-browser.wasm instance, after `_start` returned. */
  instance: WebAssembly.Instance;
  /** How ES modules are loaded: blob: URLs in browsers, data: URLs in Node. */
  moduleUrls: "blob" | "data";
  /** The fetch exposed to user code (without it, fetch rejects). */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Called exactly once when the program ends (process.exit, uncaught error, empty event loop). */
  onExit(code: number): void;
}

/** Resolves with the exit code when the program ends (after `onExit`). */
export function startEngineHost(options: EngineHostOptions): Promise<number>;
