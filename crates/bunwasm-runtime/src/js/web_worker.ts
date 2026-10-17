(function (internal: BunWasm.Internal) {
  "use strict";
  const threads = internal.require("worker_threads");
  const process = internal.require("process");
  const blobs = new Map<string, Blob>();
  type Phase = "running" | "terminating" | "closed";
  type Handler = ((event: MessageEvent) => unknown) | null;
  type GlobalHandler = { call(receiver: unknown, event: Event): unknown };

  function messageEvent(type: string, data: unknown, ports: readonly MessagePort[] = []) {
    return Object.assign(new MessageEvent(type, { data }), { data, ports });
  }
  function filePath(value: string) {
    if (!value.startsWith("file:")) return value;
    try { return internal.require("node_url").fileURLToPath(new URL(value)); }
    catch { throw new TypeError("Invalid file URL"); }
  }
  function preloadPaths(value: unknown): string[] {
    if (value === undefined) return [];
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list) || !list.every(path => typeof path === "string")) throw new TypeError("preload must be a string or an array of strings");
    return list.map(filePath);
  }
  function target(value: unknown) {
    if (!(value instanceof URL) && typeof value !== "string") throw new TypeError("Worker requires a URL or path");
    const specifier = String(value);
    if (specifier.startsWith("data:")) return { filename: new URL(specifier), eval: false };
    if (specifier.startsWith("blob:")) {
      const blob = blobs.get(specifier);
      if (!blob) return { filename: `throw new Error(${JSON.stringify(`BuildMessage: ModuleNotFound resolving "${specifier}" (entry point)`)});`, eval: true };
      const path = blob instanceof File ? blob.name : /typescript/.test(blob.type) ? "worker.ts" : "worker.js";
      try { return { filename: internal.native.workerSource(new TextDecoder().decode(blob._bytes()), path), eval: true }; }
      catch (error) { return { filename: `throw new SyntaxError(${JSON.stringify(error instanceof Error ? error.message : String(error))});`, eval: true }; }
    }
    const path = filePath(specifier);
    let resolved = path;
    try { resolved = internal.native.resolve(path, process.cwd() + "/", false); }
    catch { resolved = internal.require("path").resolve(process.cwd(), path); }
    if (resolved.startsWith("node:") || resolved === "bun" || resolved.startsWith("bun:")) {
      return { filename: `throw new Error(${JSON.stringify(`BuildMessage: Cannot use "${specifier}" as an entry point: it resolves to a builtin module`)});`, eval: true };
    }
    return { filename: resolved, eval: false };
  }
  class Worker extends EventTarget {
    #worker: BunWasm.ThreadWorker;
    #phase: Phase = "running";
    readonly threadId: number;
    onmessage: Handler = null;
    onmessageerror: Handler = null;
    onerror: ((event: ErrorEvent) => unknown) | null = null;
    onopen: ((event: Event) => unknown) | null = null;
    onclose: ((event: CloseEvent) => unknown) | null = null;
    constructor(url: unknown, rawOptions?: unknown) {
      super();
      if (rawOptions !== undefined && (rawOptions === null || typeof rawOptions !== "object")) throw new TypeError("Worker options must be an object");
      const options = rawOptions === undefined ? {} : rawOptions;
      const preload = preloadPaths("preload" in options ? options.preload : undefined);
      const name = "name" in options && options.name !== undefined ? String(options.name) : "";
      const entry = target(url);
      const unref = "ref" in options && options.ref === false;
      this.#worker = new threads.Worker(entry.filename, {
        argv: "argv" in options ? options.argv : undefined,
        env: "env" in options ? options.env : undefined,
        execArgv: "execArgv" in options ? options.execArgv : undefined,
        workerData: "data" in options ? options.data : undefined,
        eval: entry.eval, _web: { name, preload },
      });
      this.threadId = this.#worker.threadId;
      this.#worker.on("online", () => { if (this.#phase === "running") this.dispatchEvent(new Event("open")); });
      this.#worker.on("_webmessage", event => {
        if (this.#phase === "running" && event instanceof MessageEvent) this.dispatchEvent(messageEvent("message", event.data, event.ports));
      });
      this.#worker.on("messageerror", data => { if (this.#phase === "running") this.dispatchEvent(messageEvent("messageerror", data)); });
      this.#worker.on("error", error => {
        if (this.#phase !== "running") return;
        this.dispatchEvent(new ErrorEvent("error", { message: error instanceof Error ? error.message : String(error), error: error instanceof Error ? error : null, cancelable: true }));
      });
      this.#worker.once("exit", code => {
        this.#phase = "closed";
        this.dispatchEvent(new CloseEvent("close", { code: Number(code), wasClean: Number(code) === 0 }));
      });
      if (unref) this.#worker.unref();
      setImmediate(() => process.emit("worker", this));
    }
    postMessage(value: unknown, transfer?: unknown) {
      if (this.#phase !== "running") return;
      if (!arguments.length) throw new TypeError("postMessage requires a message");
      this.#worker.postMessage(value, transfer);
    }
    terminate() {
      if (this.#phase !== "running") return;
      this.#phase = "terminating";
      void this.#worker.terminate();
    }
    ref() { if (this.#phase !== "closed") this.#worker.ref(); }
    unref() { if (this.#phase !== "closed") this.#worker.unref(); }
    get [Symbol.toStringTag]() { return "Worker"; }
  }

  function initialize(port: BunWasm.WebParentPort, options: BunWasm.WebWorkerOptions, webMessageEvent: (event: MessageEvent) => MessageEvent) {
    const scope = new EventTarget();
    const initImportMeta = internal.initImportMeta;
    const start = port.start.bind(port);
    const ready = () => queueMicrotask(start);
    internal.initImportMeta = (meta, path) => {
      initImportMeta(meta, path, false);
      Object.defineProperty(meta, "__bunwasm_workerEntry", { value: ready, configurable: true });
    };
    const runMain = internal.runMain;
    internal.runMain = async path => {
      for (const preload of options.preload) await internal.importModule(internal.native.resolve(preload, process.cwd() + "/", false));
      const result = runMain(path);
      if (!(result instanceof Promise)) start();
      return result;
    };
    const listeners = new Map<string, Map<EventListenerOrEventListenerObject, { capture: boolean; wrapped: EventListener }[]>>();
    const handlers = new Map<string, GlobalHandler | null>();
    function receive(event: Event) {
      Object.assign(event, { target: globalThis, currentTarget: globalThis });
      return event;
    }
    function addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (!listener) return;
      const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
      const once = typeof options === "object" && Boolean(options?.once);
      const entries = listeners.get(type) || new Map<EventListenerOrEventListenerObject, { capture: boolean; wrapped: EventListener }[]>();
      const registered = entries.get(listener) || [];
      if (registered.some(entry => entry.capture === capture)) return;
      if (typeof options === "object" && options?.signal?.aborted) return;
      const wrapped = (event: Event) => {
        if (once) removeEventListener(type, listener, capture);
        if (typeof listener === "function") listener.call(globalThis, receive(event));
        else listener.handleEvent(receive(event));
      };
      registered.push({ capture, wrapped }); entries.set(listener, registered); listeners.set(type, entries);
      scope.addEventListener(type, wrapped, options);
      if (typeof options === "object") options?.signal?.addEventListener("abort", () => removeEventListener(type, listener, capture), { once: true });
    }
    function removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
      if (!listener) return;
      const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
      const entries = listeners.get(type);
      const registered = entries?.get(listener) || [];
      for (const entry of registered) if (entry.capture === capture) scope.removeEventListener(type, entry.wrapped, options);
      const remaining = registered.filter(entry => entry.capture !== capture);
      if (remaining.length) entries?.set(listener, remaining); else entries?.delete(listener);
    }
    for (const type of ["message", "messageerror", "error"]) {
      Object.defineProperty(globalThis, "on" + type, {
        configurable: true, enumerable: true, get: () => handlers.get(type) || null,
        set(value: unknown) { handlers.set(type, typeof value === "function" ? value : null); },
      });
      scope.addEventListener(type, event => handlers.get(type)?.call(globalThis, receive(event)));
    }
    Object.defineProperty(globalThis, "name", { value: options.name, configurable: true, writable: true });
    Object.assign(globalThis, {
      postMessage(value: unknown, transfer?: unknown) {
        if (!arguments.length) throw new TypeError("postMessage requires a message");
        port.postMessage(value, transfer);
      },
      close() { setImmediate(() => process.exit(0)); },
      addEventListener, removeEventListener,
      dispatchEvent(event: Event) {
        const accepted = scope.dispatchEvent(event);
        Object.assign(event, { target: globalThis, currentTarget: null });
        return accepted;
      },
    });
    EventTarget.prototype.addEventListener.call(port, "message", event => {
      if (event instanceof MessageEvent) scope.dispatchEvent(webMessageEvent(event));
    });
    EventTarget.prototype.addEventListener.call(port, "messageerror", event => {
      if (event instanceof MessageEvent) scope.dispatchEvent(messageEvent("messageerror", event.data));
    });
    internal.addIoWaiter({
      get ref() { return Boolean(handlers.get("message") || listeners.get("message")?.size); },
      step() { return false; },
      fail(error) { internal.workerError?.(error); },
    });
  }
  return {
    Worker, initialize,
    createObjectURL(blob: Blob) {
      if (!(blob instanceof Blob)) throw new TypeError("Expected a Blob");
      const url = "blob:bun-wasm:" + internal.randomUUID();
      blobs.set(url, blob); return url;
    },
    revokeObjectURL(url: string) { blobs.delete(String(url)); },
  };
})
