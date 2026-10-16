import type { FileHandle, ResolvedPath } from "../core";
import { MemFS, type Node } from "./memory";
import { FilesystemError } from "./protocol";

/** Storage boundary. 3b can add asynchronous loading/commit without changing guest transport.
 * execute calls are serialized by the service; no backend owns process state or completion words.
 */
export interface FilesystemBackend {
  execute(operation: string, args: any[], data: Uint8Array): unknown | Promise<unknown>;
  retain(handle: FileHandle): void;
  release(handle: FileHandle): void;
}
export class MemoryBackend implements FilesystemBackend {
  readonly fs = new MemFS();
  retain(handle: number): void { this.check(handle); this.fs.retain(handle); }
  release(handle: number): void { this.fs.release(handle); }
  private check(handle: number, kind?: "file" | "directory"): void {
    let stat;
    try { stat = this.fs.stat(handle); } catch { throw new FilesystemError(8); }
    if (kind && stat.kind !== kind) throw new FilesystemError(kind === "directory" ? 54 : 31);
  }
  private path(path: ResolvedPath): void {
    if (path.parent === undefined || path.terminalDot) return;
    this.check(path.parent, "directory");
    const current = this.fs.resolve(path.parent, path.name);
    if (typeof current === "number") throw new FilesystemError(current);
    if (current.node !== path.node) throw new FilesystemError(current.node === undefined ? 44 : 20);
  }
  execute(operation: string, args: any[], data: Uint8Array): unknown {
    const [a, b, c] = args;
    switch (operation) {
      case "preopen": return this.fs.preopen(a);
      case "resolve": this.check(a, "directory"); return this.fs.resolve(a, b);
      case "stat": this.check(a); return this.fs.stat(a);
      case "read": {
        this.check(a, "file");
        const bytes = new Uint8Array(b);
        const count = this.fs.read(a, [bytes], c);
        return bytes.subarray(0, count);
      }
      case "write": this.check(a, "file"); return this.fs.write(a, [data], b);
      case "resize": this.check(a, "file"); return this.fs.resize(a, b, c);
      case "setMtime": this.check(a); return this.fs.setMtime(a, b);
      case "readdir": this.check(a, "directory"); return this.fs.readdir(a);
      case "create": this.path(a); if (a.node !== undefined) return { error: 20 }; return this.fs.create(a, b);
      case "link": this.path(a); this.path(b); return this.fs.link(a, b);
      case "removePath": this.path(a); return this.fs.removePath(a, b);
      case "rename": this.path(a); this.path(b); return this.fs.rename(a, b);
      case "lookup": {
        const node = this.fs.lookup(a);
        if (!node) return undefined;
        const metadata = (node: Node) => ({ kind: node.kind, ino: node.ino, mtime: node.mtime });
        return node.kind === "file" ? metadata(node) : { ...metadata(node), children: new Map(Array.from(node.children, ([name, child]) => [name, metadata(child)])) };
      }
      case "readFile": return this.fs.readFile(a)?.slice();
      case "writeFile": this.fs.writeFile(a, data.slice(), b ?? false); return;
      case "mkdirp": this.fs.mkdirp(a); return;
      case "remove": return this.fs.remove(a);
      case "listFiles": return this.fs.listFiles(a);
      case "move": {
        const root = this.fs.preopen("/");
        const from = this.fs.resolve(root, a.replace(/^\//, ""));
        const to = this.fs.resolve(root, b.replace(/^\//, ""));
        if (typeof from === "number") return from;
        if (typeof to === "number") return to;
        return this.fs.rename(from, to);
      }
      default: throw new FilesystemError(52, `unknown filesystem operation ${operation}`);
    }
  }
}
