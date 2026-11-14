import type { DescriptorTable, Resource } from "waffle/core/descriptors";
import { FilesystemClient } from "../node_modules/waffle/fs/client.ts";
import { shareFileResource, withFileOffset } from "../node_modules/waffle/core/open-file.ts";
import { CommandStdioError } from "../node_modules/waffle/proc/command.ts";

/** Restricted CommandStdio adaptation: one awaited stderr writer shares its process's FS client. */
export class ContinuationIO {
  constructor(private readonly table: DescriptorTable, readonly filesystem: FilesystemClient, private readonly abort: AbortSignal) {}

  check(): void { if (this.abort.aborted) throw new CommandStdioError("CANCELED"); }
  private resource(): Exclude<Resource, { kind: "directory" }> {
    this.check();
    const descriptor = this.table.get(2);
    if (!descriptor || !(descriptor.rightsBase & 64n) || descriptor.resource.kind === "directory") throw new CommandStdioError("EBADF");
    return descriptor.resource;
  }

  async write(text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    while (offset < bytes.length) {
      const count = await this.transfer(bytes.subarray(offset, offset + 65536));
      if (!count) throw new CommandStdioError("EIO", "Output accepted no bytes");
      offset += count;
    }
    this.resource();
  }

  private async transfer(bytes: Uint8Array): Promise<number> {
    for (;;) {
      const resource = this.resource();
      const words = this.notifications(resource);
      const observed = words.map(word => Atomics.load(word, 0));
      const count = resource.kind === "file" ? this.file(resource, bytes) : resource.tryWrite?.([bytes]);
      this.check();
      if (count === undefined) throw new CommandStdioError("EIO", "Nonblocking I/O is unavailable");
      if (count >= 0) return count;
      if (count !== -6) throw ioError(count);
      if (!words.length) throw new CommandStdioError("EIO", "I/O has no readiness notification");
      await this.ready(words, observed);
    }
  }

  private notifications(resource: Exclude<Resource, { kind: "directory" }>): Int32Array[] {
    if (resource.kind !== "file") return resource.notification ? [resource.notification] : [];
    const offset = shareFileResource(resource, this.filesystem.connection);
    return [new Int32Array(this.filesystem.connection.signal), new Int32Array(offset, 0, 1)];
  }

  private file(resource: Extract<Resource, { kind: "file" }>, bytes: Uint8Array): number {
    return withFileOffset(resource, () => {
      if (resource.append) return this.append(resource, bytes);
      const written = this.filesystem.tryWrite(resource.handle, [bytes], resource.offset);
      if (written > 0) resource.offset += written;
      return written;
    }, true);
  }

  private append(resource: Extract<Resource, { kind: "file" }>, bytes: Uint8Array): number {
    const result = this.filesystem.tryAppend(resource.handle, [bytes]);
    if (typeof result === "number") return result;
    resource.offset = result.offset;
    return result.written;
  }

  private async ready(words: Int32Array[], observed: number[]): Promise<void> {
    this.check();
    const cancelled = Promise.withResolvers<void>();
    const cancel = () => { cancelled.resolve(); for (const word of words) Atomics.notify(word, 0); };
    this.abort.addEventListener("abort", cancel, { once: true });
    try {
      const waits: unknown[] = words.map((word, index) => Atomics.waitAsync(word, 0, observed[index] ?? 0).value);
      if (this.abort.aborted) cancel();
      await Promise.race(waits.concat([cancelled.promise]));
      for (const word of words) Atomics.notify(word, 0);
      this.check();
    } finally { this.abort.removeEventListener("abort", cancel); }
  }

  async settle(): Promise<void> {
    await this.filesystem.stopResidentPublication();
    this.filesystem.dispose();
  }
}

function ioError(count: number): CommandStdioError {
  if (count === -64) return new CommandStdioError("EPIPE");
  if (count === -8 || count === -76) return new CommandStdioError("EBADF");
  if (count === -11) return new CommandStdioError("CANCELED");
  return new CommandStdioError("EIO", `I/O failed with errno ${-count}`);
}
