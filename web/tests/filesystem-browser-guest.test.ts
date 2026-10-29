import { expect, test } from "bun:test";
import {
  FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity,
  createFilesystemConnection, revokeFilesystem,
} from "waffle/fs";

function fixture() {
  const root = createFilesystemConnection();
  const service = new FilesystemService(new MemoryBackend());
  service.connect(root.server);
  const client = new FilesystemClient(root.client, { connect(identity) {
    const pair = connectFilesystemIdentity(identity, root.pool);
    service.connect(pair.server);
    return pair.client;
  } });
  return { client, dispose() { client.dispose(); service.dispose(); } };
}

test("filesystem browser writers use host-owned connections with guest MessageChannel replaced", async () => {
  const host = fixture();
  const workers: Worker[] = [];
  const connections: ReturnType<FilesystemClient["fork"]>[] = [];
  try {
    const results = await Promise.all(Array.from({ length: 2 }, () => {
      const connection = host.client.fork();
      connections.push(connection);
      const worker = new Worker(new URL("./filesystem-browser-guest.ts", import.meta.url).href);
      workers.push(worker);
      return new Promise<unknown>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(event.error);
        worker.postMessage({ connection, action: "writers" }, [connection.port]);
      });
    }));
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    const files = await host.client.asyncCall("listFiles", ["/"]);
    expect(files).toHaveLength(40);
    const root = await host.client.asyncCall("preopen", ["/"]);
    const entries = await host.client.asyncCall("readdir", [root]);
    expect(new Set(entries.map((entry: { ino: number }) => entry.ino)).size).toBe(40);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    for (const connection of connections) revokeFilesystem(connection);
    host.dispose();
  }
});

test("host connector forks a working shared-tree client after MessageChannel replacement", async () => {
  const host = fixture();
  const native = globalThis.MessageChannel;
  let peer: FilesystemClient | undefined;
  try {
    Object.assign(globalThis, { MessageChannel: class { constructor() { throw new Error("guest MessageChannel used by host transport"); } } });
    peer = new FilesystemClient(host.client.fork());
    await peer.asyncCall("writeFile", ["/host-fork"], new TextEncoder().encode("shared"));
    expect(await host.client.asyncCall("readFile", ["/host-fork"])).toEqual(new TextEncoder().encode("shared"));
  } finally {
    globalThis.MessageChannel = native;
    peer?.dispose();
    host.dispose();
  }
});
