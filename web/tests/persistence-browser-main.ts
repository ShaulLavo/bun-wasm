// Conformance-only implementation override, never exposed by either product page.
import { withVfsImplementation } from "../node_modules/waffle/fs/vfs-internal.ts";
import { SharedFilesystem, WORKSPACE_TAKEN_OVER, UNSAVED_CHANGES_LOST } from "../src/shared-fs";

let fs: SharedFilesystem | undefined;
let worker: Worker | undefined;
let next = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const state = { commitStarted: false, boundary: undefined as string | undefined, partialWrite: false, progress: "idle", ownershipLost: false, ownershipMessage: "" };
function direct(command: string, args?: unknown): Promise<any> {
  if (!worker) {
    worker = new Worker("./persistence-browser-worker.js", { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.event === "persist-started") { state.commitStarted = true; state.boundary = data.boundary; state.partialWrite = data.partialWrite === true; return; }
      if (data.event === "progress") { state.progress = data.value; return; }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value);
    };
    worker.onerror = event => {
      for (const request of pending.values()) request.reject(new Error(event.message));
      pending.clear();
    };
  }
  const id = ++next;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ id, command, args }); });
}
Object.assign(globalThis, {
  persistenceHarness: {
    state,
    async open(name: string, persistence = true, storage: "indexeddb" | "opfs" = "indexeddb") {
      await fs?.dispose();
      state.ownershipLost = false; state.ownershipMessage = "";
      fs = new SharedFilesystem(withVfsImplementation(persistence ? storage === "opfs" ? "opfs-memory" : "indexeddb" : "memory", { name, mode: persistence ? "fast" : "memory" }));
      fs.onOwnershipLost = () => {
        state.ownershipLost = true;
        state.ownershipMessage = `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`;
      };
      await fs.flush();
    },
    async write(path: string, bytes: number[]) { await fs!.writeFile(path, Uint8Array.from(bytes)); },
    async move(from: string, to: string) { await fs!.move(from, to); },
    async remove(path: string) { return fs!.remove(path); },
    async mkdir(path: string) { await fs!.mkdirp(path); },
    async flush() { await fs!.flush(); },
    async unlinkWhileOpen() {
      if (!fs) throw new Error("filesystem not opened");
      await fs.writeFile("/held.bin", Uint8Array.from([0, 255, 1, 0, 128]));
      const descriptor = new Worker("./safari-open-descriptor-worker.js", { type: "module" });
      function reply(): Promise<unknown> {
        return new Promise((resolve, reject) => {
          descriptor.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
          descriptor.onerror = event => reject(new Error(event.message));
        });
      }
      try {
        const ready = reply(), connection = fs.fork();
        descriptor.postMessage({ kind: "open", connection }, [connection.port]);
        await ready;
        await fs.remove("/held.bin"); await fs.flush();
        const missing = await fs.lookup("/held.bin");
        if (missing) throw new Error("unlinked path is still visible");
        const bytes = reply(); descriptor.postMessage({ kind: "read" });
        return await bytes;
      } finally { descriptor.terminate(); }
    },
    async snapshot() {
      const files = (await fs!.listFiles()).sort();
      return Promise.all(files.map(async path => ({ path, metadata: await fs!.lookup(path), bytes: Array.from((await fs!.readFile(path))!) })));
    },
    direct,
    storageState() { return fs?.state.status; },
    async destroy() {
      await fs?.dispose(); fs = undefined;
      if (worker) { await direct("close"); worker.terminate(); worker = undefined; }
    },
    async deleteDatabase(name: string, storage: "indexeddb" | "opfs" = "indexeddb") {
      await direct("deleteDatabase", { name, storage });
    },
  },
});
