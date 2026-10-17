import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection, createProcessFilesystemIdentity } from "../fs";
import { FilesystemSection, isRevoked } from "../fs/protocol";

test("shutdown fences independent users and waits for admitted work before flushing and closing", async () => {
  const events: string[] = [];
  class Backend extends MemoryBackend {
    async close() { events.push("flush"); events.push("unlock"); }
  }
  const backend = new Backend();
  const pair = createFilesystemConnection();
  const service = new FilesystemService(backend);
  const client = new FilesystemClient(pair.client);
  service.connect(pair.server);
  const child = createProcessFilesystemIdentity(pair.client);
  const section = new FilesystemSection(pair.client);
  section.enter();
  let closed = false;
  try {
    const closing = service.shutdown().then(() => { closed = true; });
    expect(isRevoked(child)).toBe(true);
    expect(() => client.submit("writeFile", ["/late"])).toThrow();
    const late = createFilesystemConnection();
    try { expect(() => service.connect(late.server)).toThrow(); }
    finally { late.client.port.close(); late.server.port.close(); }
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(events).toEqual([]);
    section.exit();
    await closing;
    await service.shutdown();
    expect(events).toEqual(["flush", "unlock"]);
    expect(service.resources().clients).toBe(0);
  } finally {
    if (Atomics.load(new Int32Array(pair.client.sections), 0)) section.exit();
    client.dispose(); service.dispose();
  }
});

test("shutdown drains a cold preparation before closing its backend", async () => {
  let started!: () => void, resume!: () => void;
  const preparing = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  const events: string[] = [];
  class Backend extends MemoryBackend {
    async prepare() { started(); await released; events.push("prepared"); }
    async close() { events.push("closed"); }
  }
  const service = new FilesystemService(new Backend());
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  service.connect(pair.server);
  const pending = client.asyncCall("readFile", ["/cold"]).catch(() => undefined);
  try {
    await preparing;
    const closing = service.shutdown();
    await Promise.resolve();
    expect(events).toEqual([]);
    resume();
    await closing; await pending;
    expect(events).toEqual(["prepared", "closed"]);
  } finally { resume(); client.dispose(); service.dispose(); }
});
