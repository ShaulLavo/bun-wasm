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
    stall() { serviceBackend.prepareDescriptorRead = () => new Promise(resolve => { releases.push(() => resolve(new Uint8Array())); }); },
    disposed: () => connections.every(pair => isRevoked(pair.client)),
    outstanding: () => Array.from(held.values()).reduce((total, set) => total + set.size, 0),
    filesystem: { fork() {
      const pair = createFilesystemConnection(owner.client);
      connections.push(pair);
      const pending = new Set<number>();
      held.set(connections.length, pending);
      const send = pair.client.port.postMessage.bind(pair.client.port);
      pair.client.port.postMessage = (message: unknown, transfer?: StructuredSerializeOptions | Transferable[]) => {
        track(message, pending);
        if (Array.isArray(transfer)) send(message, transfer);
        else send(message, transfer);
      };
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
function track(message: unknown, pending: Set<number>): void {
  if (!message || typeof message !== "object") return;
  if ("id" in message && typeof message.id === "number") pending.add(message.id);
  if ("discard" in message && typeof message.discard === "number") pending.delete(message.discard);
}
