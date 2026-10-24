// Types for engine-host.js (plain JS): runs the program in the worker's own JS engine after
// bun-browser.wasm's `_start` returned with `bunwasm_ready() === 1`.

export interface EngineHostOptions {
  /** The bun-browser.wasm instance, after `_start` returned. */
  instance: WebAssembly.Instance;
  /** How ES modules are loaded: blob: URLs in browsers, data: URLs in Node. */
  moduleUrls: "blob" | "data";
  /**
   * A module store: named URLs that the host's module loader serves from what was put (the
   * service worker in the playground, module hooks in Node). Needed for import cycles; without it
   * modules get `moduleUrls` URLs.
   */
  modules?: { url(key: string): string; put(url: string, source: string): void | Promise<void> };
  /** The fetch exposed to user code (without it, fetch rejects). */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Networking: the bun_wasm host ABI (docs/host-abi.md) as the functions the runtime's net.js
   * calls (hostListen, hostRead, …), which slots they cover, and a way to wake the event loop.
   * Without it (or without its fetch), user code gets `fetch` above and no servers.
   */
  net?: {
    natives: Record<string, (...args: never[]) => unknown>;
    caps: Record<string, boolean>;
    onNews(cb: () => void): void;
  };
  /**
   * The process wake word that pipe and child changes publish on (Waffle's worker process state).
   * While the program waits on I/O, the event loop wakes on it instead of only rescanning.
   */
  processWake?: Int32Array;
  /** Called exactly once when the program ends (process.exit, uncaught error, empty event loop). */
  onExit(code: number): void;
}

/** Resolves with the exit code when the program ends (after `onExit`). */
export function startEngineHost(options: EngineHostOptions): Promise<number>;
