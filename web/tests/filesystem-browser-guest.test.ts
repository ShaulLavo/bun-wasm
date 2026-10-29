import { expect, test } from "bun:test";
import {
  FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity,
  createFilesystemConnection, revokeFilesystem,
} from "waffle/fs";

class GuestMessageChannel {
  constructor() { throw new Error("guest MessageChannel used by host transport"); }
}

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

function writer(connection: ReturnType<FilesystemClient["fork"]>) {
  const worker = new Worker(new URL("./filesystem-browser-guest.ts", import.meta.url).href);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<unknown>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("filesystem writer did not reply")), 3000);
    worker.onmessage = event => resolve(event.data);
    worker.onerror = event => reject(event.error);
    worker.postMessage({ connection, action: "writers" }, [connection.port]);
  });
  return { worker, done: done.finally(() => clearTimeout(deadline)) };
}

test("filesystem browser writers use host-owned connections with guest MessageChannel replaced", async () => {
  const host = fixture();
  const workers: Worker[] = [];
  const connections: ReturnType<FilesystemClient["fork"]>[] = [];
  try {
    const results = await Promise.all(Array.from({ length: 2 }, () => {
      const connection = host.client.fork();
      connections.push(connection);
      const { worker, done } = writer(connection);
      workers.push(worker);
      return done;
    }));
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    const files = await host.client.asyncCall("listFiles", ["/"]);
    expect(files).toHaveLength(40);
    const root = await host.client.asyncCall("preopen", ["/"]);
    const entries: ReturnType<FilesystemClient["readdir"]> = await host.client.asyncCall("readdir", [root]);
    const filesOnly = entries.filter(entry => entry.name !== "." && entry.name !== "..");
    expect(new Set(filesOnly.map(entry => entry.ino)).size).toBe(40);
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
    Object.assign(globalThis, { MessageChannel: GuestMessageChannel });
    peer = new FilesystemClient(host.client.fork());
    await peer.asyncCall("writeFile", ["/host-fork"], new TextEncoder().encode("shared"));
    expect(await host.client.asyncCall("readFile", ["/host-fork"])).toEqual(new TextEncoder().encode("shared"));
  } finally {
    globalThis.MessageChannel = native;
    peer?.dispose();
    host.dispose();
  }
});
