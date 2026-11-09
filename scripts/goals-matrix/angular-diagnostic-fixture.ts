import { MemoryBackend, type FilesystemBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import { createFilesystemConnection } from "waffle/fs";
import { MemFS } from "waffle/fs/memory";
import { isRevoked } from "waffle/fs/protocol";

export const diagnosticPath = "/tmp/ng-9kxMAf/angular-errors.log";
export type DiagnosticFixture = { contents?: string; missing?: boolean; symlink?: string; stalled?: boolean; replacement?: { path: string; after: "resolve" | "stat" } };

export function diagnosticFilesystem(config: DiagnosticFixture) {
  const fs = new MemFS();
  fs.mkdirp("/tmp/ng-9kxMAf");
  fs.mkdirp("/home/user/ng-9kxMAf");
  for (const path of ["/home/user/private.txt", "/home/user/angular-errors.log", "/home/user/ng-9kxMAf/angular-errors.log"]) fs.writeFile(path, "PRIVATE FILE MUST NOT BE READ");
  if (!config.missing) fs.writeFile(diagnosticPath, config.contents ?? "RangeError: Maximum call stack size exceeded\n    at ajv/dist/compile/codegen/index.js:181:24");
  const expected = fs.lookup(diagnosticPath)?.ino ?? -1;
  function replace(path: string): void {
    fs.remove(path);
    const resolved = fs.resolveAbsolute(path, false);
    if (typeof resolved === "number") throw new Error("Cannot replace diagnostic fixture path");
    if (fs.symlink(resolved, path === diagnosticPath ? "/home/user/private.txt" : "/home/user") !== 0) throw new Error("Cannot create diagnostic symlink");
  }
  if (config.symlink) replace(config.symlink);
  const backend = new MemoryBackend(fs);
  const serviceBackend: FilesystemBackend = backend;
  const service = new FilesystemService(serviceBackend);
  const operations: string[] = [];
  const readInodes: number[] = [];
  const ranges: unknown[][] = [];
  let replaced = false;
  let lastResolved = "";
  const execute = backend.execute.bind(backend);
  backend.execute = (operation, args, bytes) => {
    operations.push(operation);
    if (operation === "read") { readInodes.push(fs.nodeForHandle(args[0]).ino); ranges.push(args.slice(1)); }
    const result = execute(operation, args, bytes);
    if (operation === "resolve") lastResolved = args[1];
    const race = config.replacement;
    if (race && !replaced && operation === race.after && lastResolved === race.path.slice(race.path.lastIndexOf("/") + 1)) { replace(race.path); replaced = true; }
    return result;
  };
  let releaseRead: (() => void) | undefined;
  if (config.stalled) serviceBackend.prepareDescriptorRead = () => new Promise(resolve => { releaseRead = () => resolve(new Uint8Array()); });
  const connections: ReturnType<typeof createFilesystemConnection>[] = [];
  return {
    operations, readInodes, ranges, expected, replaced: () => replaced, disposed: () => connections.every(pair => isRevoked(pair.client)),
    filesystem: { fork() { const pair = createFilesystemConnection(); connections.push(pair); service.connect(pair.server); return pair.client; } },
    async close() {
      releaseRead?.();
      await service.shutdown();
      for (const pair of connections) { pair.client.port.close(); pair.server.port.close(); }
    },
  };
}
