import { describe, expect, test } from "bun:test";
import { MemoryBackend } from "waffle/fs";
import { templates } from "../sandbox/src/template-catalog";
import { templateFiles } from "../sandbox/template-files";
import { evictIdle, type EvictionDependencies } from "../sandbox/src/workspace-eviction";
import { evictionOrder, IDLE_INSTALLS_KEPT, isStorageFull, regenerableOutputs, StorageRecovery, workspaceName } from "../sandbox/src/workspace-policy";
import { restoreSource } from "../sandbox/src/workspace-restore";
import { APP, excludedRoots, parseSnapshot, PreservationRefused, readSource, retainedPath, RESTORE_MARKER, SEED_MARKER, SOURCE_LIMIT_BYTES, SOURCE_LIMIT_ENTRIES, type SourceMetadata, type SourceReader, type SourceSnapshot } from "../sandbox/src/workspace-source";

const encode = (text: string) => new TextEncoder().encode(text);
function metadata(path: string, kind: SourceMetadata["kind"] = "file", size = 0): SourceMetadata {
  return { path, kind, size, ino: 1, nlink: 1, mode: kind === "dir" ? 0o700 : 0o600, mtime: 1 };
}

function reader(entries: readonly SourceMetadata[], files: ReadonlyMap<string, Uint8Array> = new Map()) {
  const reads: string[] = [];
  let closed = false;
  const source: SourceReader = {
    walk: () => ({ next: async () => ({ entries: entries.concat([metadata(SEED_MARKER, "dir")]), done: true }), close: async () => { closed = true; } }),
    readFile: async (path, options) => { options.signal.throwIfAborted(); reads.push(path); return files.get(path); },
  };
  return { source, reads, closed: () => closed };
}

describe("whole stored user tree", () => {
  test("every shipped template path overrides exclusions", async () => {
    for (const template of templates) {
      const files = await templateFiles(`${import.meta.dir}/../sandbox/${template.directory}`);
      const ignored = excludedRoots(regenerableOutputs(template.id), new Set(Object.keys(files)));
      for (const path of Object.keys(files)) expect(retainedPath(`${APP}/${path}`, ignored)).toBe(true);
    }
  });

  test("only exact regenerable roots are excluded", () => {
    const ignored = excludedRoots([".next"], new Set([".next/owned.txt"]));
    for (const path of [".env", ".config/settings.json", "src/.private/data", "build/notes", "dist/data", ".next/owned.txt", "node_modules-old/data", "src/node_modules/user.ts"]) expect(retainedPath(`${APP}/${path}`, ignored)).toBe(true);
    expect(retainedPath("/home/user/data.json", ignored)).toBe(true);
    expect(retainedPath(`${APP}/node_modules/pkg/index.js`, ignored)).toBe(false);
    expect(retainedPath("/home/user/.bun/install/cache/bun-wasm/pkg", ignored)).toBe(false);
    expect(retainedPath("/home/user/.bun/install/cache/user-data", ignored)).toBe(true);
  });

  test("binary bytes, empty directories, outside-app files and template deletions are explicit", async () => {
    const files = new Map([[`${APP}/.env`, encode("secret=local")], ["/data.bin", new Uint8Array([0, 255, 128])]]);
    const entries = [metadata("/", "dir"), metadata(`${APP}/empty`, "dir")].concat(Array.from(files, ([path, data]) => metadata(path, "file", data.length)));
    const fixture = reader(entries, files);
    const snapshot = await readSource(fixture.source, "vanilla", []);
    expect(parseSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(snapshot.entries.map(entry => entry.path)).not.toContain(`${APP}/deleted-template.ts`);
    expect(snapshot.bytes).toBe(15);
    expect(fixture.closed()).toBe(true);
  });

  test("all sizes are checked before any file read", async () => {
    const fixture = reader([metadata("/small", "file", 1), metadata("/huge", "file", SOURCE_LIMIT_BYTES + 1)]);
    await expect(readSource(fixture.source, "vanilla", [])).rejects.toBeInstanceOf(PreservationRefused);
    expect(fixture.reads).toEqual([]);
    expect(fixture.closed()).toBe(true);
  });

  test("entry count, unsupported metadata, failed reads and cancellation refuse the entire snapshot", async () => {
    const cases = [
      Array.from({ length: SOURCE_LIMIT_ENTRIES + 1 }, (_, i) => metadata(`/dir${i}`, "dir")),
      [metadata("/link", "symlink")], [metadata("/socket", "socket")],
      [{ ...metadata("/hard"), nlink: 2 }], [{ ...metadata("/mode"), mode: 0o400 }],
      [metadata("/missing", "file", 4)], [metadata("/bad/../path")],
    ];
    for (const entries of cases) {
      const fixture = reader(entries);
      await expect(readSource(fixture.source, "vanilla", [])).rejects.toBeInstanceOf(PreservationRefused);
      expect(fixture.closed()).toBe(true);
    }
    const fixture = reader([]);
    await expect(readSource(fixture.source, "vanilla", [], AbortSignal.abort("cancelled"))).rejects.toBe("cancelled");
    expect(fixture.closed()).toBe(true);
  });
});

test("LRU only intersects actual stored names with the catalog", () => {
  expect(IDLE_INSTALLS_KEPT).toBe(1);
  expect(evictionOrder([{ template: "a", lastOpened: 10 }], [workspaceName("a"), workspaceName("b"), workspaceName("current"), workspaceName("unknown")], ["a", "b", "current"], "current")).toEqual(["b", "a"]);
});

function evictionFixture() {
  const events: string[] = [];
  const snapshots = new Map<string, SourceSnapshot>();
  const fixture = reader([metadata("/", "dir")]);
  const deps: EvictionDependencies = {
    stored: async () => ["old", "new", "active"].map(workspaceName),
    openIdle: async name => name === workspaceName("active") ? "busy" : { ...fixture.source, delete: async () => { events.push(`delete:${name}`); }, close: async () => { events.push(`close:${name}`); } },
    policy: async () => ({ outputs: [], templatePaths: new Set<string>() }),
    clearDownloadCache: async () => { events.push("clear-cache"); return true; },
    index: {
      records: async () => [{ template: "old", lastOpened: 1 }, { template: "new", lastOpened: 2 }],
      opened: async () => {}, reset: async () => {}, restored: async () => true,
      source: async template => snapshots.get(template),
      preserve: async snapshot => { snapshots.set(snapshot.template, snapshot); events.push(`preserve:${snapshot.template}`); },
    },
  };
  return { deps, events, snapshots };
}

test("one newest eligible idle install remains; active workspace is protected", async () => {
  const { deps, events } = evictionFixture();
  const report = await evictIdle(deps, ["old", "new", "active"], "current", 1);
  expect(report.evicted).toEqual(["old"]);
  expect(report.busy).toEqual(["active"]);
  expect(events.indexOf("preserve:old")).toBeLessThan(events.indexOf(`delete:${workspaceName("old")}`));
  expect(events).not.toContain(`delete:${workspaceName("new")}`);
});

test("preserve failure retries once after cache deletion and never deletes an unpreserved tree", async () => {
  const { deps, events } = evictionFixture();
  deps.index.preserve = async () => { events.push("preserve-failed"); throw new DOMException("full", "QuotaExceededError"); };
  const report = await evictIdle(deps, ["old", "new"], "current", 0);
  expect(report.kept).toHaveLength(2);
  expect(events.filter(event => event === "clear-cache")).toHaveLength(1);
  expect(events.filter(event => event.startsWith("delete:"))).toEqual([]);
  expect(events.filter(event => event.startsWith("close:"))).toHaveLength(2);
});

test("native deletion failure retains its backup and actual failure", async () => {
  const { deps, snapshots } = evictionFixture();
  const failure = new Error("blocked native deletion");
  const openIdle = deps.openIdle;
  const report = await evictIdle({ ...deps, openIdle: async (name, signal) => {
    const handle = await openIdle(name, signal);
    return typeof handle === "string" ? handle : { ...handle, delete: async () => { throw failure; } };
  } }, ["old"], "current", 0);
  expect(report.evicted).toEqual([]);
  expect(report.kept[0]?.error).toBe(failure);
  expect(snapshots.has("old")).toBe(true);
});

test("quota detection includes bounded installer output and cyclic causes", () => {
  for (const text of ["filesystem errno 51", "QuotaExceededError: Filesystem worker failed: QuotaExceededError", "error: ENOSPC"]) expect(isStorageFull(new Error("install failed", { cause: text }))).toBe(true);
  const cycle = { cause: undefined as unknown };
  cycle.cause = cycle;
  expect(isStorageFull(cycle)).toBe(false);
  expect(isStorageFull(new Error("network error"))).toBe(false);
});

test("concurrent reports share one reclaim, retry exited operations, and bound retries", async () => {
  let finish!: () => void;
  let reclaims = 0;
  const recovery = new StorageRecovery(() => { reclaims++; return new Promise<void>(resolve => { finish = resolve; }); });
  const full = new Error("errno 51");
  const a = recovery.recover(full);
  const b = recovery.recover(full);
  expect(a).toBe(b);
  expect(reclaims).toBe(1);
  finish();
  await a;
  let installs = 0;
  const retried = recovery.retry(async () => { if (++installs === 1) throw full; return "installed"; });
  await Promise.resolve();
  finish();
  expect(await retried).toBe("installed");
  expect(installs).toBe(2);
});

function restoreFixture() {
  const memory = new MemoryBackend().fs;
  const events: string[] = [];
  const control = { failWrite: "", failFlush: false };
  const fs: Parameters<typeof restoreSource>[0] = {
    lookup: async path => memory.lookup(path), readFile: async path => memory.readFile(path),
    mkdirp: async path => { memory.mkdirp(path); }, remove: async path => memory.remove(path),
    writeFile: async (path, data) => {
      if (path === control.failWrite) throw new Error("interrupted restore");
      memory.writeFile(path, typeof data === "string" ? encode(data) : data);
      events.push(`write:${path}`);
    },
    flush: async () => { events.push("flush"); if (control.failFlush) throw new Error("errno 51"); },
  };
  return { memory, fs, events, control };
}

test("whole-tree restore retries interruption without resurrecting deleted template files", async () => {
  const fixture = reader([metadata("/", "dir"), metadata("/home", "dir"), metadata("/home/user", "dir"), metadata(APP, "dir"), metadata(`${APP}/empty`, "dir"), metadata(`${APP}/.env`, "file", 3), metadata("/outside", "file", 2)], new Map([[`${APP}/.env`, encode("env")], ["/outside", new Uint8Array([0, 255])]]));
  const source = await readSource(fixture.source, "vanilla", []);
  const { deps, snapshots } = evictionFixture();
  snapshots.set("vanilla", source);
  const { memory, fs, events, control } = restoreFixture();
  memory.mkdirp(APP);
  memory.writeFile(`${APP}/old-deleted.ts`, encode("old template"));
  control.failWrite = "/outside";
  await expect(restoreSource(fs, deps.index, "vanilla")).rejects.toThrow("interrupted restore");
  expect(memory.lookup(SEED_MARKER)).toBeUndefined();
  expect(snapshots.get("vanilla")).toBe(source);
  control.failWrite = "";
  let acknowledged = false;
  deps.index.restored = async (_, id) => { expect(id).toBe(source.id); expect(events.at(-1)).toBe("flush"); acknowledged = true; snapshots.delete("vanilla"); return true; };
  await restoreSource(fs, deps.index, "vanilla");
  expect(acknowledged).toBe(true);
  expect(memory.lookup(`${APP}/old-deleted.ts`)).toBeUndefined();
  expect(memory.lookup(`${APP}/empty`)?.kind).toBe("dir");
  expect(memory.readFile("/outside")).toEqual(new Uint8Array([0, 255]));
  expect(memory.readFile(`${APP}/.env`)).toEqual(encode("env"));
});

test("marker must name the snapshot; failed flush retains source and a later matching ack is safe", async () => {
  const source = await readSource(reader([metadata("/", "dir")]).source, "vanilla", []);
  const { deps, snapshots } = evictionFixture();
  snapshots.set("vanilla", source);
  const { memory, fs, control } = restoreFixture();
  control.failFlush = true;
  let acks = 0;
  deps.index.restored = async () => { acks++; return true; };
  await expect(restoreSource(fs, deps.index, "vanilla")).rejects.toThrow("errno 51");
  expect(acks).toBe(0);
  expect(memory.lookup(SEED_MARKER)).toBeDefined();
  memory.writeFile(RESTORE_MARKER, encode("another snapshot"));
  await restoreSource(fs, deps.index, "vanilla");
  expect(acks).toBe(0);
  memory.writeFile(RESTORE_MARKER, encode(source.id));
  control.failFlush = false;
  await restoreSource(fs, deps.index, "vanilla");
  expect(acks).toBe(1);
});
