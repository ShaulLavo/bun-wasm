import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient, FilesystemService, createFilesystemConnection } from "../fs";
import type { PersistenceBatch, PersistedIndex, StorageBackend } from "../fs/storage";

class Store implements StorageBackend {
  index?: PersistedIndex;
  payloads = new Map<string, Uint8Array>();
  syncs: (readonly string[] | undefined)[] = [];
  async load() { return this.index; }
  async read(key: string) { return this.payloads.get(key)!.slice(); }
  async persist(batch: PersistenceBatch) {
    const nodes = new Map(this.index?.nodes.map(node => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, node);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, data] of batch.data) this.payloads.set(key, data.slice());
    this.index = { version: 1, generation: batch.generation, root: batch.root, nodes: Array.from(nodes.values()) };
  }
  async flush(keys?: readonly string[]) { this.syncs.push(keys); }
  async close() {}
}

test("background checkpoints close-only; file sync and persisted save scope payload durability", async () => {
  const store = new Store();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    backend.execute("writeFile", ["/a"], new TextEncoder().encode("a"));
    backend.execute("writeFile", ["/b"], new TextEncoder().encode("b"));
    await backend.checkpoint();
    expect(store.syncs.length).toBe(0);
    await backend.flush("/a");
    const a = backend.fs.lookup("/a")!;
    const key = store.index!.nodes.find(node => node.ino === a.ino)!.data!;
    expect(store.syncs).toEqual([[key]]);
    await backend.flush(backend.fs.handleForNode(a));
    expect(store.syncs.at(-1)).toEqual([key]);
    await backend.flush();
    expect(store.syncs.at(-1)).toBeUndefined();
  } finally { backend.dispose(); }
});

test("failed payload fsync retries without rolling back an already committed generation", async () => {
  class FailingSync extends Store {
    fail = true;
    generations: number[] = [];
    override async persist(batch: PersistenceBatch) {
      this.generations.push(batch.generation);
      await super.persist(batch);
    }
    override async flush(keys?: readonly string[]) {
      if (this.fail) { this.fail = false; throw new Error("injected payload flush failure"); }
      await super.flush(keys);
    }
  }
  const store = new FailingSync();
  const backend = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    backend.execute("writeFile", ["/a"], new TextEncoder().encode("first"));
    await expect(backend.flush("/a")).rejects.toThrow("injected payload flush failure");
    expect(store.generations).toEqual([1]);
    await backend.flush("/a");
    expect(store.generations).toEqual([1]);
    backend.execute("writeFile", ["/a"], new TextEncoder().encode("second"));
    await backend.flush("/a");
    expect(store.generations).toEqual([1, 2]);
    const key = store.index!.nodes.find(node => node.kind === "file")!.data!;
    expect(new TextDecoder().decode(await store.read(key))).toBe("second");
  } finally { backend.dispose(); }
});

test("service fd_sync forwards the checked file identity rather than flushing every file", async () => {
  class Observed extends MemoryBackend {
    syncs: (number | string | undefined)[] = [];
    async flush(target?: number | string) { this.syncs.push(target); }
  }
  const backend = new Observed();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(); service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    await client.asyncCall("writeFile", ["/a"], new TextEncoder().encode("a"));
    const path = await client.asyncCall("resolve", [root, "a"]);
    expect(await client.asyncCall("sync", [path.node])).toBe(0);
    expect(backend.syncs).toEqual([path.node]);
  } finally { client.dispose(); service.dispose(); }
});
