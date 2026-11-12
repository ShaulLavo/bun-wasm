import { parseSnapshot, type SourceSnapshot } from "./workspace-source";

export interface WorkspaceRecord { readonly template: string; readonly lastOpened: number }

export interface WorkspaceIndexStore {
  records(): Promise<WorkspaceRecord[]>;
  opened(template: string, now: number): Promise<void>;
  preserve(snapshot: SourceSnapshot): Promise<void>;
  source(template: string): Promise<SourceSnapshot | undefined>;
  restored(template: string, snapshotId: string, now: number): Promise<boolean>;
  reset(template: string, now: number): Promise<void>;
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException("Snapshot transaction aborted", "AbortError"));
    transaction.onerror = () => {};
  });
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function parseRecord(value: unknown): WorkspaceRecord {
  if (!value || typeof value !== "object" || !("template" in value) || typeof value.template !== "string" || !("lastOpened" in value) || typeof value.lastOpened !== "number" || !Number.isFinite(value.lastOpened)) throw new Error("Invalid workspace index record");
  return { template: value.template, lastOpened: value.lastOpened };
}

export class WorkspaceIndex implements WorkspaceIndexStore {
  private constructor(private readonly database: IDBDatabase) {}

  static open(factory: IDBFactory = indexedDB, name = "bun-wasm-sandbox-index"): Promise<WorkspaceIndex> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      let failed = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore("workspaces", { keyPath: "template" });
        request.result.createObjectStore("sources", { keyPath: "template" });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { failed = true; reject(new Error("Workspace source index is blocked")); };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        if (failed) { database.close(); return; }
        resolve(new WorkspaceIndex(database));
      };
    });
  }

  close(): void { this.database.close(); }

  private async transaction<T>(stores: string[], mode: IDBTransactionMode, action: (transaction: IDBTransaction) => Promise<T> | T): Promise<T> {
    const transaction = this.database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
    const done = completed(transaction);
    try {
      const result = await action(transaction);
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* A completed or aborted transaction cannot be aborted again. */ }
      await done.catch(() => {});
      throw error;
    }
  }

  records(): Promise<WorkspaceRecord[]> {
    return this.transaction(["workspaces"], "readonly", async transaction => {
      const values: unknown[] = await requested(transaction.objectStore("workspaces").getAll());
      return values.map(parseRecord);
    });
  }

  opened(template: string, now: number): Promise<void> {
    return this.transaction(["workspaces"], "readwrite", transaction => this.touch(transaction, template, now));
  }

  preserve(snapshot: SourceSnapshot): Promise<void> {
    parseSnapshot(snapshot);
    return this.transaction(["sources"], "readwrite", transaction => {
      transaction.objectStore("sources").put(snapshot);
    });
  }

  source(template: string): Promise<SourceSnapshot | undefined> {
    return this.transaction(["sources"], "readonly", async transaction => {
      const value: unknown = await requested(transaction.objectStore("sources").get(template));
      if (value === undefined) return;
      const snapshot = parseSnapshot(value);
      if (snapshot.template !== template) throw new Error("Snapshot template does not match its key");
      return snapshot;
    });
  }

  restored(template: string, snapshotId: string, now: number): Promise<boolean> {
    return this.transaction(["sources", "workspaces"], "readwrite", async transaction => {
      const sources = transaction.objectStore("sources");
      const value: unknown = await requested(sources.get(template));
      if (value === undefined || parseSnapshot(value).id !== snapshotId) return false;
      sources.delete(template);
      await this.touch(transaction, template, now);
      return true;
    });
  }

  reset(template: string, now: number): Promise<void> {
    return this.transaction(["sources", "workspaces"], "readwrite", async transaction => {
      transaction.objectStore("sources").delete(template);
      await this.touch(transaction, template, now);
    });
  }

  private async touch(transaction: IDBTransaction, template: string, now: number): Promise<void> {
    const store = transaction.objectStore("workspaces");
    const value: unknown = await requested(store.get(template));
    const lastOpened = value === undefined ? now : Math.max(now, parseRecord(value).lastOpened);
    store.put({ template, lastOpened });
  }
}
