import { MemoryBackend, type FilesystemBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import { createFilesystemConnection } from "waffle/fs";
import { MemFS } from "waffle/fs/memory";
import { isRevoked } from "waffle/fs/protocol";
import { nextBuildFiles } from "./next-build-files";

export function nextBuildFilesystem() {
  const fs = new MemFS();
  fs.mkdirp("/home/user/.next/diagnostics");
  fs.writeFile("/home/user/private.txt", "PRIVATE MUST NOT BE READ");
  const backend = new MemoryBackend(fs);
  const serviceBackend: FilesystemBackend = backend;
  const service = new FilesystemService(serviceBackend);
  const owner = createFilesystemConnection();
  service.connect(owner.server);
  const connections: ReturnType<typeof createFilesystemConnection>[] = [];
  const operations: { operation: string; args: unknown[]; at: number }[] = [];
  const reads: { ino: number; length: unknown; offset: unknown }[] = [];
  const held = new Map<number, Set<number>>();
  const original = backend.execute.bind(backend);
  let replaceAfter: { path: string; operation: "resolve" | "stat" } | undefined;
  let lastName = "";
  let stalledReads = 0;
  // Requests the page's client has sent and not yet seen answered, and whether it handled a reply this turn.
  const awaiting = new Set<string>();
  let delivering = false;
  backend.execute = (operation, args, bytes) => {
    operations.push({ operation, args: args.slice(), at: Date.now() });
    if (operation === "read") reads.push({ ino: fs.nodeForHandle(args[0]).ino, length: args[1], offset: args[2] });
    const result = original(operation, args, bytes);
    if (operation === "resolve") lastName = args[1];
    if (replaceAfter?.operation === operation && lastName === replaceAfter.path.split("/").at(-1)) { symlink(replaceAfter.path); replaceAfter = undefined; }
    return result;
  };
  const releases: (() => void)[] = [];
  function symlink(path: string): void {
    fs.remove(path);
    const location = fs.resolveAbsolute(path, false);
    if (typeof location === "number") throw new Error("Cannot resolve symlink fixture");
    if (fs.symlink(location, "/home/user/private.txt") !== 0) throw new Error("Cannot create fixture symlink");
  }
  return {
    fs, operations, reads, symlink,
    replace(path: string, operation: "resolve" | "stat") { replaceAfter = { path, operation }; },
    write(files: Partial<Record<typeof nextBuildFiles[number]["path"], string>>) { for (const [path, text] of Object.entries(files)) original("writeFile", [path, false, false], new TextEncoder().encode(text)); },
    stall() { serviceBackend.prepareDescriptorRead = () => new Promise(resolve => { stalledReads++; releases.push(() => resolve(new Uint8Array())); }); },
    stalledReads: () => stalledReads,
    /**
     * True once this many file reads have started and the page's client has handled the reply to
     * every request it sent, and a turn of the event loop has run the code those replies wake (a
     * read's next request, or its result). The backend finishing is not enough: a reply can still
     * be on its way to the page.
     */
    readsSettled: (count: number) => operations.filter(row => row.operation === "read").length >= count && awaiting.size === 0 && !delivering,
    disposed: () => connections.every(pair => isRevoked(pair.client)),
    outstanding: () => Array.from(held.values()).reduce((total, set) => total + set.size, 0),
    filesystem: { fork() {
      const pair = createFilesystemConnection(owner.client);
      connections.push(pair);
      const pending = new Set<number>();
      held.set(connections.length, pending);
      const send = pair.client.port.postMessage.bind(pair.client.port);
      const connection = connections.length;
      pair.client.port.postMessage = (message: unknown, transfer?: StructuredSerializeOptions | Transferable[]) => {
        track(message, pending);
        if (message && typeof message === "object" && "id" in message) awaiting.add(`${connection}:${String(message.id)}`);
        if (Array.isArray(transfer)) send(message, transfer);
        else send(message, transfer);
      };
      observeReplies(pair.client.port, reply => {
        awaiting.delete(`${connection}:${String(reply)}`);
        delivering = true;
        setTimeout(() => { delivering = false; }, 0);
      });
      service.connect(pair.server);
      return pair.client;
    } },
    async close() {
      for (const release of releases) release();
      await service.shutdown();
      for (const pair of connections) { pair.client.port.close(); pair.server.port.close(); }
      owner.client.port.close(); owner.server.port.close();
    },
  };
}
/** Calls `replied` with a reply's request id after the port's own message handler has run. */
function observeReplies(port: MessagePort, replied: (id: unknown) => void): void {
  let prototype: object | null = Object.getPrototypeOf(port);
  let descriptor: PropertyDescriptor | undefined;
  while (prototype && !descriptor?.set) { descriptor = Object.getOwnPropertyDescriptor(prototype, "onmessage"); prototype = Object.getPrototypeOf(prototype); }
  const accessor = descriptor;
  if (!accessor?.get || !accessor.set) throw new Error("Cannot observe filesystem replies");
  Object.defineProperty(port, "onmessage", { configurable: true,
    get: () => accessor.get?.call(port),
    set: (listener: ((event: MessageEvent) => void) | null) => accessor.set?.call(port, typeof listener !== "function" ? listener : (event: MessageEvent) => {
      try { listener.call(port, event); }
      finally { if (event.data && typeof event.data === "object" && "completed" in event.data) replied(event.data.completed); }
    }),
  });
}
function track(message: unknown, pending: Set<number>): void {
  if (!message || typeof message !== "object") return;
  if ("id" in message && typeof message.id === "number") pending.add(message.id);
  if ("discard" in message && typeof message.discard === "number") pending.delete(message.discard);
}
