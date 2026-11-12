import { WorkspaceIndex } from "../src/workspace-index";
import { parseSnapshot, type SourceSnapshot } from "../src/workspace-source";
import { WorkspaceStorage } from "../src/workspace-storage";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function snapshot(text: string): SourceSnapshot {
  const data = new TextEncoder().encode(text);
  return { id: crypto.randomUUID(), template: "vanilla", takenAt: Date.now(), bytes: data.length, entries: [{ kind: "file", path: "/home/user/data", mode: 0o600, mtime: 1, data }] };
}

async function deleted(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test database deletion blocked"));
  });
}

export async function indexTransactions(): Promise<string[]> {
  const name = `sandbox-index-test-${crypto.randomUUID()}`;
  const index = await WorkspaceIndex.open(indexedDB, name);
  const results: string[] = [];
  try {
    const first = snapshot("first");
    const second = snapshot("second");
    await index.opened("vanilla", 100);
    await completeBeforeResolve(index, first);
    results.push("strict-complete-before-preserve-resolves");
    await abortedAfterSuccess(index, second);
    assert((await index.source("vanilla"))?.id === first.id, "aborted preserve changed durable source");
    results.push("request-success-followed-by-native-abort-keeps-first");
    await index.preserve(second);
    await index.opened("vanilla", 300);
    assert(!await index.restored("vanilla", first.id, 200), "stale S1 ack accepted");
    assert((await index.source("vanilla"))?.id === second.id, "stale S1 ack erased S2");
    assert((await index.records())[0]?.lastOpened === 300, "stale ack regressed open time");
    assert(await index.restored("vanilla", second.id, 200), "same-ID ack refused");
    assert((await index.records())[0]?.lastOpened === 300, "matching ack regressed open time");
    results.push("conditional-S1-ack-cannot-erase-S2-or-newer-open");
    await index.preserve(second);
    await index.reset("vanilla", 400);
    assert(await index.source("vanilla") === undefined, "reset retained source intent");
    assert(!await index.restored("vanilla", second.id, 100), "late restore undid reset");
    results.push("reset-invalidates-source-and-late-ack");
  } finally { index.close(); await deleted(name); }
  await upgradeAbort();
  results.push("native-upgrade-abort-rejected");
  await serializedReset();
  results.push("origin-operation-lock-serializes-independent-resetters");
  return results;
}

async function serializedReset(): Promise<void> {
  const workspaces = { stored: async () => [], openIdle: async (): Promise<"missing"> => "missing" };
  const first = await WorkspaceStorage.open(workspaces, "vanilla", () => {});
  const second = await WorkspaceStorage.open(workspaces, "vanilla", () => {});
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  const a = first.reset(async () => { events.push("first"); entered(); await gate; events.push("first-complete"); });
  const b = second.reset(async () => { events.push("second"); });
  try {
    await start;
    assert(events.join(",") === "first", "second reset escaped the origin lock");
    release();
    await Promise.all([a, b]);
    assert(events.join(",") === "first,first-complete,second", "resets overlapped");
  } finally { release(); await Promise.allSettled([a, b]); first.close(); second.close(); await deleted("bun-wasm-sandbox-index"); }
}

async function completeBeforeResolve(index: WorkspaceIndex, source: SourceSnapshot): Promise<void> {
  const transaction = IDBDatabase.prototype.transaction;
  const events: string[] = [];
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
    const result = transaction.apply(this, args);
    if (args[1] === "readwrite") assert(args[2]?.durability === "strict", "preservation durability is not strict");
    result.addEventListener("complete", () => events.push("complete"));
    return result;
  };
  try { await index.preserve(source); events.push("resolved"); } finally { IDBDatabase.prototype.transaction = transaction; }
  assert(events.join(",") === "complete,resolved", `early preservation ${events.join(",")}`);
}

async function abortedAfterSuccess(index: WorkspaceIndex, source: SourceSnapshot): Promise<void> {
  const put = IDBObjectStore.prototype.put;
  let requestSucceeded = false;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    const result = put.apply(this, args);
    const transaction = this.transaction;
    result.addEventListener("success", () => { requestSucceeded = true; transaction.abort(); });
    return result;
  };
  let rejected = false;
  try { await index.preserve(source); } catch { rejected = true; } finally { IDBObjectStore.prototype.put = put; }
  assert(requestSucceeded && rejected, "native request success plus abort was reported saved");
}

async function upgradeAbort(): Promise<void> {
  const open = IDBFactory.prototype.open;
  const name = `sandbox-index-upgrade-test-${crypto.randomUUID()}`;
  IDBFactory.prototype.open = function (...args: Parameters<IDBFactory["open"]>) {
    const request = open.apply(this, args);
    request.addEventListener("upgradeneeded", () => request.transaction?.abort());
    return request;
  };
  let rejected = false;
  try { (await WorkspaceIndex.open(indexedDB, name)).close(); } catch { rejected = true; } finally { IDBFactory.prototype.open = open; await deleted(name); }
  assert(rejected, "aborted index upgrade was reported successful");
}

export async function quotaTransaction(): Promise<string[]> {
  const name = `sandbox-index-quota-test-${crypto.randomUUID()}`;
  const index = await WorkspaceIndex.open(indexedDB, name);
  const source = snapshot("before quota");
  await index.preserve(source);
  Object.assign(globalThis, { storageQuotaTest: { index, name, source } });
  return [name];
}

export async function refusedQuotaTransaction(): Promise<string[]> {
  const state: unknown = Reflect.get(globalThis, "storageQuotaTest");
  assert(state && typeof state === "object" && "index" in state && state.index instanceof WorkspaceIndex && "name" in state && typeof state.name === "string" && "source" in state, "quota test not prepared");
  const { index, name } = state;
  const source = snapshot("refused");
  const random = new Uint8Array(8 * 1024 * 1024 - 1024);
  for (let offset = 0; offset < random.length; offset += 65536) crypto.getRandomValues(random.subarray(offset, offset + 65536));
  const large = { ...source, bytes: random.length, entries: [{ kind: "file" as const, path: "/random", mode: 0o600, mtime: 1, data: random }] };
  let failure: unknown;
  let failedTemplate = "";
  for (let attempt = 0; attempt < 8 && !failure; attempt++) {
    failedTemplate = `quota-${attempt}`;
    try { await index.preserve({ ...large, template: failedTemplate }); } catch (error) { failure = error; }
  }
  try {
    assert(failure instanceof DOMException && failure.name === "QuotaExceededError", `control native write did not fail with quota: ${String(failure)}`);
    assert(await index.source(failedTemplate) === undefined, "quota-failed preserve changed source");
    assert((await index.source("vanilla"))?.id === parseSnapshot(state.source).id, "quota pressure changed previous source");
    return ["native-quota-transaction-refused-and-source-retained"];
  } finally { index.close(); await deleted(name); Reflect.deleteProperty(globalThis, "storageQuotaTest"); }
}

Object.assign(globalThis, { sandboxIndexChecks: { indexTransactions, quotaTransaction, refusedQuotaTransaction } });
