import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection, connectFilesystemIdentity, createProcessFilesystemIdentity, type FilesystemConnection } from "waffle/fs";

export function installPortObserver(endpoint: string): void {
  const marker = Symbol.for("bun-wasm.storage-firefox-observer");
  if (Reflect.get(globalThis, marker)) return;
  Reflect.set(globalThis, marker, true);
  const realm = crypto.randomUUID();
  const ports = new WeakMap<MessagePort, { id: number; owner?: number; generation?: number; recent: unknown[]; seen: number }>();
  let next = 0;
  let sequence = 0;
  let queued: unknown[] = [];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const pending = new Set<Promise<unknown>>();
  const flush = () => {
    if (!queued.length) return;
    const batch = queued;
    queued = [];
    const sent = nativeFetch(endpoint, { method: "POST", body: JSON.stringify(batch), keepalive: true }).catch(() => {});
    pending.add(sent);
    void sent.finally(() => pending.delete(sent));
  };
  Reflect.set(globalThis, Symbol.for("bun-wasm.storage-firefox-drain"), async () => {
    flush();
    await Promise.all(Array.from(pending));
  });
  const emit = (event: unknown) => {
    queued.push({ realm, sequence: ++sequence, at: performance.timeOrigin + performance.now(), url: location.href, event });
    if (queued.length >= 16) flush();
  };
  function describe(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object") return { type: typeof value };
    const result: Record<string, unknown> = { keys: Object.keys(value).slice(0, 16) };
    for (const key of ["id", "generation", "offset", "length", "segment", "completed", "transportClosed", "stopWorkspace", "sweep", "trim", "discard"])
      if (key in value) result[key] = Reflect.get(value, key);
    if ("buffer" in value) {
      const buffer: unknown = Reflect.get(value, "buffer");
      result.buffer = buffer instanceof SharedArrayBuffer ? { kind: "shared", bytes: buffer.byteLength } : { kind: typeof buffer };
    }
    return result;
  }
  function observe(port: MessagePort, connection?: object, role?: string): void {
    const previous = ports.get(port);
    if (previous) return;
    const owner: unknown = connection && Reflect.get(connection, "owner");
    const requests: unknown = connection && Reflect.get(connection, "requests");
    const generation: unknown = requests && typeof requests === "object" ? Reflect.get(requests, "generation") : undefined;
    const recent: unknown[] = [];
    const state = { id: ++next, owner: typeof owner === "number" ? owner : undefined, generation: typeof generation === "number" ? generation : undefined, recent, seen: 0 };
    ports.set(port, state);
    emit({ kind: "port", id: state.id, owner: state.owner, generation: state.generation, role });
    port.addEventListener("message", event => note(port, "receive", event.data));
    port.addEventListener("messageerror", event => {
      emit({ kind: "messageerror", port: state.id, owner: state.owner, generation: state.generation, trusted: event.isTrusted, recent: state.recent.slice() });
      flush();
    });
  }
  function scan(value: unknown, role = "envelope"): void {
    if (!value || typeof value !== "object") return;
    const port: unknown = Reflect.get(value, "port");
    if (port instanceof MessagePort) observe(port, value, role);
    for (const key of ["filesystem", "connect", "connection"]) {
      const child: unknown = Reflect.get(value, key);
      if (child && typeof child === "object" && child !== value) scan(child, key);
    }
  }
  function note(port: MessagePort, direction: string, value: unknown): void {
    observe(port);
    const state = ports.get(port)!;
    const message = describe(value);
    const event = { kind: "message", direction, port: state.id, owner: state.owner, generation: state.generation, message };
    state.recent.push(event);
    if (state.recent.length > 16) state.recent.shift();
    if (++state.seen <= 4 || "segment" in message || "transportClosed" in message) emit(event);
    scan(value);
  }
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) {
    note(this, "send", args[0]);
    return Reflect.apply(post, this, args);
  };
  if (typeof Worker !== "undefined") {
    const workerPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) {
      scan(args[0]);
      return Reflect.apply(workerPost, this, args);
    };
  }
  globalThis.addEventListener("message", event => scan(event.data));
  globalThis.addEventListener("error", event => { emit({ kind: "error", message: "message" in event ? String(event.message) : event.type }); flush(); });
  globalThis.addEventListener("unhandledrejection", event => { emit({ kind: "unhandledrejection", reason: "reason" in event ? String(event.reason) : event.type }); flush(); });
  globalThis.addEventListener("pagehide", flush);
  setInterval(flush, 250);
  emit({ kind: "realm", isolated: crossOriginIsolated });
  flush();
}

function waitFor(worker: Worker, expected: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`qualification ${expected} deadline`)), 15_000);
    worker.addEventListener("message", ({ data }) => {
      if (data?.type !== expected) return;
      clearTimeout(timeout);
      resolve(data);
    });
    worker.addEventListener("error", event => { clearTimeout(timeout); reject(Error(event.message)); }, { once: true });
  });
}

async function drainObserver(): Promise<void> {
  const drain: unknown = Reflect.get(globalThis, Symbol.for("bun-wasm.storage-firefox-drain"));
  if (typeof drain !== "function") throw Error("observer drain missing");
  await drain();
}

export async function qualify(url: string): Promise<unknown> {
  const root = createFilesystemConnection();
  const owner = new Worker(`${url}?role=service`, { type: "module" });
  const fs = new FilesystemClient(root.client);
  let child: Worker | undefined;
  let pair: ReturnType<typeof connectFilesystemIdentity> | undefined;
  try {
    owner.postMessage({ connect: root.server }, [root.server.port]);
    await fs.asyncCall("preopen", ["/"]);
    await fs.asyncCall("writeFile", ["/growth"], new Uint8Array(17 * 1024 * 1024).fill(90));
    await new Promise(resolve => setTimeout(resolve, 0));
    pair = connectFilesystemIdentity(createProcessFilesystemIdentity(root.client), root.pool);
    owner.postMessage({ connect: pair.server }, [pair.server.port]);
    child = new Worker(`${url}?role=client`, { type: "module" });
    const positive = waitFor(child, "positive");
    child.postMessage({ connection: pair.client }, [pair.client.port]);
    const before = await positive;
    const injected = waitFor(child, "injected");
    child.postMessage({ inject: true });
    const after = await injected;
    const healthyRoot = await fs.asyncCall("preopen", ["/"]);
    const flushed = waitFor(owner, "flushed");
    owner.postMessage({ flush: true });
    await flushed;
    await drainObserver();
    return { before, after, healthyRoot, isolated: crossOriginIsolated };
  } finally {
    child?.terminate();
    pair?.client.port.close();
    pair?.server.port.close();
    fs.dispose();
    root.server.port.close();
    owner.terminate();
  }
}

function qualificationWorker(role: string): void {
  if (role === "service") {
    const service = new FilesystemService(new MemoryBackend());
    globalThis.onmessage = async ({ data }: MessageEvent<{ connect?: FilesystemConnection; flush?: boolean }>) => {
      if (data.connect) return service.connect(data.connect);
      await drainObserver();
      self.postMessage({ type: "flushed" });
    };
    return;
  }
  let fs: FilesystemClient;
  let port: MessagePort;
  globalThis.onmessage = async ({ data }: MessageEvent<{ connection?: FilesystemConnection; inject?: boolean }>) => {
    if (data.inject) return inject();
    if (!data.connection) throw Error("qualification connection missing");
    port = data.connection.port;
    fs = new FilesystemClient(data.connection);
    const root = await fs.asyncCall("preopen", ["/"]);
    self.postMessage({ type: "positive", root });
  };
  async function inject(): Promise<void> {
    port.dispatchEvent(new MessageEvent("messageerror"));
    let result: Record<string, unknown>;
    try { fs.preopen("/"); result = { type: "injected", missed: true }; }
    catch (error) {
      const closed = error instanceof Error && "code" in error && error.code === "CLOSED";
      result = { type: "injected", closed, error: String(error) };
    }
    await drainObserver();
    self.postMessage(result);
  }
}
if (typeof location !== "undefined" && location.pathname === "/probe.js") {
  const role = new URL(location.href).searchParams.get("role");
  if (role) qualificationWorker(role);
}
