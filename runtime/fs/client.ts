import type { FileSystem, FileHandle, FileStat, DirectoryEntry, ResolvedPath } from "../core";
import { HEADER, PAGE, State, FilesystemError, createFilesystemConnection, errno, isRevoked, pack, revokeFilesystem, unpack, wake, type FilesystemConnection } from "./protocol";

const asyncAtomics = Atomics as typeof Atomics & {
  waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> };
};

export class FilesystemCompletion {
  readonly cells: Int32Array;
  private changed: (() => void)[] = [];
  private cancellations = new Set<() => void>();
  private decoded: unknown;
  private loading?: Promise<unknown>;
  private consumed = false;
  constructor(readonly id: number, readonly buffer: SharedArrayBuffer, private client: FilesystemClient) { this.cells = new Int32Array(buffer, 0, HEADER / 4); }
  get ready(): boolean { return isRevoked(this.client.connection) || Atomics.load(this.cells, 0) !== State.Pending; }
  get epoch(): number { return this.cells[5]!; }
  notify(): void { for (const done of this.changed.splice(0)) done(); }
  cancel(): void {
    if (Atomics.exchange(this.cells, 6, 1)) return;
    Atomics.compareExchange(this.cells, 0, State.Pending, State.Cancelled);
    Atomics.notify(this.cells, 0);
    wake(this.client.connection);
    this.client.connection.port.postMessage({ discard: this.id });
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    this.notify();
  }
  release(): void {
    // Shared state can be ready before its port notification wakes value(). An unconsumed
    // release cancels that value and notifies its waiters before removing the completion.
    if (!this.consumed) this.cancel();
    else this.client.connection.port.postMessage({ discard: this.id });
    this.client.completions.delete(this.id);
    if (!this.client.completions.size) wake(this.client.connection);
  }
  private check(): void {
    if (isRevoked(this.client.connection) || this.cells[6] || this.cells[0] === State.Cancelled) throw new FilesystemError(11);
    if (this.cells[0] === State.Failed) throw new FilesystemError(this.cells[3]!);
  }
  private decode(bytes: Uint8Array): unknown { return this.cells[4] ? bytes : unpack(bytes); }
  wait(): any {
    const signal = new Int32Array(this.client.connection.signal);
    while (!this.ready) {
      const observed = Atomics.load(signal, 0);
      this.check();
      if (!this.ready) Atomics.wait(signal, 0, observed);
    }
    this.check();
    if (this.consumed) return this.decoded;
    const size = this.cells[2]!;
    let bytes = new Uint8Array(this.buffer, HEADER, Math.min(size, this.buffer.byteLength - HEADER)).slice();
    if (this.cells[0] === State.Overflow) {
      bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += PAGE) bytes.set(this.client.call("take", [this.id, at, PAGE]), at);
    }
    this.check();
    this.decoded = this.decode(bytes); this.consumed = true;
    return this.decoded;
  }
  async value(): Promise<any> {
    if (!this.ready) await new Promise<void>(resolve => {
      this.changed.push(resolve);
      this.client.watchRevocation();
      // The response may have arrived between the check and registration.
      if (this.ready) this.notify();
    });
    this.check();
    if (this.consumed) return this.decoded;
    // All waiters consume the same overflow transfer; the final take deletes the stored bytes.
    return this.loading ??= this.load();
  }
  private async load(): Promise<unknown> {
    const size = this.cells[2]!;
    let bytes = new Uint8Array(this.buffer, HEADER, Math.min(size, this.buffer.byteLength - HEADER)).slice();
    if (this.cells[0] === State.Overflow) {
      bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += PAGE) {
        const part = this.client.submit("take", [this.id, at, PAGE]);
        const cancel = () => part.cancel();
        this.cancellations.add(cancel);
        try {
          this.check();
          bytes.set(await part.value(), at);
        } finally {
          this.cancellations.delete(cancel);
          part.release();
        }
      }
    }
    this.check();
    this.decoded = this.decode(bytes); this.consumed = true;
    return this.decoded;
  }
}
/** Blocking preview1 adapter and non-blocking request/completion API for the async host.
 * Read/stat caches are validated by the service's global seqlock. A concurrent mutation invalidates
 * before changing data; a cached read that overlaps it is discarded, never returned as fresh.
 */
export class FilesystemClient implements FileSystem {
  readonly completions = new Map<number, FilesystemCompletion>();
  private nextRequest = 1;
  private reads = new Map<number, { offset: number; bytes: Uint8Array; epoch: number }>();
  private stats = new Map<number, { stat: FileStat; epoch: number }>();
  private paths = new Map<string, { path: ResolvedPath | number; epoch: number }>();
  private watchingRevocation = false;
  constructor(readonly connection: FilesystemConnection) {
    connection.port.onmessage = ({ data }) => this.completions.get(data.completed)?.notify();
    connection.port.start();
  }
  /** A single shared-signal waiter handles service death without a port completion message.
   * Normal replies still use the port; the watcher exits when the last completion is released.
   */
  watchRevocation(): void {
    if (this.watchingRevocation) return;
    this.watchingRevocation = true;
    void this.monitorRevocation();
  }
  private async monitorRevocation(): Promise<void> {
    const signal = new Int32Array(this.connection.signal);
    try {
      while (this.completions.size) {
        const observed = Atomics.load(signal, 0);
        if (isRevoked(this.connection)) {
          for (const completion of this.completions.values()) completion.cancel();
          return;
        }
        const waiting = asyncAtomics.waitAsync(signal, 0, observed);
        if (waiting.async) await waiting.value;
      }
    } finally { this.watchingRevocation = false; }
  }
  fork(): FilesystemConnection {
    if (isRevoked(this.connection)) throw new FilesystemError(11);
    const connection = createFilesystemConnection(this.connection);
    this.connection.port.postMessage({ connect: connection.server }, [connection.server.port]);
    return connection.client;
  }
  sweep(): void { this.connection.port.postMessage({ sweep: true }); }
  submit(operation: string, args: unknown[] = [], data: Uint8Array = new Uint8Array(), capacity = operation === "read" || operation === "take" || operation === "readdir" ? PAGE : 1024): FilesystemCompletion {
    if (isRevoked(this.connection)) throw new FilesystemError(11);
    const input = pack({ operation, args });
    const buffer = new SharedArrayBuffer(HEADER + Math.max(input.length + data.length, capacity));
    const completion = new FilesystemCompletion(this.nextRequest++, buffer, this);
    completion.cells[1] = input.length; completion.cells[2] = data.length;
    new Uint8Array(buffer, HEADER).set(input);
    new Uint8Array(buffer, HEADER + input.length).set(data);
    this.completions.set(completion.id, completion);
    this.connection.port.postMessage({ id: completion.id, buffer });
    return completion;
  }
  readiness(id: number): { kind: 3; id: number; ready: boolean } | undefined {
    const completion = this.completions.get(id);
    return completion && { kind: 3, id, ready: completion.ready };
  }
  call(operation: string, args: unknown[] = [], data?: Uint8Array): any {
    const completion = this.submit(operation, args, data);
    try { return completion.wait(); } finally { completion.release(); }
  }
  async asyncCall(operation: string, args: unknown[] = [], data?: Uint8Array): Promise<any> {
    const completion = this.submit(operation, args, data);
    try { return await completion.value(); } finally { completion.release(); }
  }
  dispose(): void {
    revokeFilesystem(this.connection);
    for (const completion of this.completions.values()) completion.cancel();
    this.completions.clear(); this.reads.clear(); this.stats.clear(); this.paths.clear();
    this.sweep(); this.connection.port.close();
  }
  private version(): number {
    if (isRevoked(this.connection)) throw new FilesystemError(11);
    return Atomics.load(new Int32Array(this.connection.epoch), 0);
  }
  preopen(path: string): FileHandle { return this.call("preopen", [path]); }
  retain(handle: FileHandle): void { this.call("retain", [handle]); }
  release(handle: FileHandle): void { this.reads.delete(handle); this.stats.delete(handle); this.paths.clear(); this.call("release", [handle]); }
  resolve(directory: FileHandle, path: string): ResolvedPath | number {
    try {
      const epoch = this.version();
      const key = `${directory}\0${path}`;
      const cached = this.paths.get(key);
      if (!(epoch & 1) && cached?.epoch === epoch) return typeof cached.path === "number" ? cached.path : { ...cached.path };
      const completion = this.submit("resolve", [directory, path]);
      try {
        const resolved: ResolvedPath | number = completion.wait();
        if (this.paths.size >= 256) this.paths.clear();
        this.paths.set(key, { path: resolved, epoch: completion.epoch });
        return typeof resolved === "number" ? resolved : { ...resolved };
      } finally { completion.release(); }
    } catch (error) { return errno(error); }
  }
  stat(handle: FileHandle): FileStat {
    const epoch = this.version();
    const cached = this.stats.get(handle);
    if (!(epoch & 1) && cached?.epoch === epoch) return { ...cached.stat };
    const completion = this.submit("stat", [handle]);
    try {
      const stat = completion.wait();
      if (this.stats.size >= 256) this.stats.clear();
      this.stats.set(handle, { stat, epoch: completion.epoch });
      return { ...stat };
    } finally { completion.release(); }
  }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    let total = 0;
    try {
      for (const chunk of chunks) {
        let at = 0;
        while (at < chunk.length) {
          const position = offset + total;
          const epoch = this.version();
          let cached = this.reads.get(handle);
          if ((epoch & 1) || cached?.epoch !== epoch || position < cached.offset || position >= cached.offset + cached.bytes.length) {
            const completion = this.submit("read", [handle, PAGE, position]);
            try {
              cached = { offset: position, bytes: completion.wait(), epoch: completion.epoch };
              if (this.reads.size >= 16) this.reads.clear();
              this.reads.set(handle, cached);
            } finally { completion.release(); }
          }
          const start = position - cached.offset;
          const count = Math.min(chunk.length - at, cached.bytes.length - start);
          if (this.version() !== cached.epoch) continue;
          // A rejected cache entry must not write speculative bytes past the final short read.
          chunk.set(cached.bytes.subarray(start, start + count), at);
          at += count; total += count;
          if (!count || cached.bytes.length < PAGE && start + count === cached.bytes.length) return total;
        }
      }
      return total;
    } catch (error) { return total || -errno(error); }
  }
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    let total = 0;
    try {
      for (const chunk of chunks) for (let at = 0; at < chunk.length; at += PAGE) total += this.call("write", [handle, offset + total], chunk.subarray(at, at + PAGE));
      return total;
    } catch (error) { return total || -errno(error); }
  }
  append(handle: FileHandle, chunks: readonly Uint8Array[]): { written: number; offset: number } | number {
    try {
      const data = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
      // The entire iovec is one service operation so sibling appends cannot interleave its pages.
      return this.call("append", [handle], data);
    } catch (error) { return -errno(error); }
  }
  resize(handle: FileHandle, size: number, truncate: boolean): number {
    try { return this.call("resize", [handle, size, truncate]); } catch (error) { return errno(error); }
  }
  setMtime(handle: FileHandle, mtime: number): number {
    try { return this.call("setMtime", [handle, mtime]); } catch (error) { return errno(error); }
  }
  readdir(handle: FileHandle): DirectoryEntry[] { return this.call("readdir", [handle]); }
  create(path: ResolvedPath, kind: "file" | "directory", exclusive = true): FileHandle | { error: number } {
    try { return this.call("create", [path, kind, exclusive]); } catch (error) { return { error: errno(error) }; }
  }
  link(from: ResolvedPath, to: ResolvedPath): number { try { return this.call("link", [from, to]); } catch (error) { return errno(error); } }
  removePath(path: ResolvedPath, directory: boolean): number { try { return this.call("removePath", [path, directory]); } catch (error) { return errno(error); } }
  rename(from: ResolvedPath, to: ResolvedPath): number { try { return this.call("rename", [from, to]); } catch (error) { return errno(error); } }
  lookup(path: string): any { return this.call("lookup", [path]); }
  writeFile(path: string, value: string | Uint8Array, append = false): void { this.call("writeFile", [path, append], typeof value === "string" ? new TextEncoder().encode(value) : value); }
}
