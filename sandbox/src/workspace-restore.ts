import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import type { WorkspaceIndexStore } from "./workspace-index";
import { APP, RESTORE_MARKER, SEED_MARKER, type SourceSnapshot } from "./workspace-source";
import { raceAbort } from "../../web/src/workspace-claims";

type Filesystem = Pick<Runtime["filesystem"], "lookup" | "remove" | "mkdirp" | "writeFile" | "readFile" | "flush"> & {
  fork?: Runtime["filesystem"]["fork"];
};

export interface RestoreSourceOptions {
  signal?: AbortSignal;
  beforeFirstMutation?: () => void;
}

async function abortableLookup(fs: Filesystem, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal || !fs.fork) return fs.lookup(path);
  const client = new FilesystemClient(fs.fork());
  const onAbort = () => { try { client.dispose(); } catch {} };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const res = await client.asyncCall("lookup", [path]);
    signal.throwIfAborted();
    return res;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { client.dispose(); } catch {}
  }
}

async function abortableReadFile(fs: Filesystem, path: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  signal?.throwIfAborted();
  if (!signal || !fs.fork) return fs.readFile(path);
  const client = new FilesystemClient(fs.fork());
  const onAbort = () => { try { client.dispose(); } catch {} };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const res = await client.asyncCall("readFile", [path]);
    signal.throwIfAborted();
    return res;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { client.dispose(); } catch {}
  }
}

/** Caller serializes restore and explicit reset with the template / reset gate locks. */
export async function restoreSource(
  fs: Filesystem,
  index: WorkspaceIndexStore,
  template: string,
  options: RestoreSourceOptions = {},
): Promise<void> {
  const { signal, beforeFirstMutation } = options;
  signal?.throwIfAborted();
  const snapshot = await raceAbort(index.source(template), signal);
  if (!snapshot) return;
  signal?.throwIfAborted();
  if (await abortableLookup(fs, SEED_MARKER, signal)) {
    const restoredId = await abortableReadFile(fs, RESTORE_MARKER, signal);
    if (restoredId && new TextDecoder().decode(restoredId) === snapshot.id) {
      beforeFirstMutation?.();
      await acknowledge(fs, index, snapshot);
    }
    return;
  }
  const root = await abortableLookup(fs, "/", signal);
  if (root?.kind !== "dir") throw new Error("Cannot restore source without a filesystem root");
  const rootNames = Array.from(root.children.keys(), String);
  signal?.throwIfAborted();
  beforeFirstMutation?.();
  await replaceTree(fs, snapshot, rootNames);
  await acknowledge(fs, index, snapshot);
}

async function replaceTree(fs: Filesystem, snapshot: SourceSnapshot, rootNames: readonly string[]): Promise<void> {
  for (const name of rootNames) await fs.remove(`/${name}`);
  const entries = snapshot.entries.toSorted((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const entry of entries) {
    if (entry.kind === "dir") await fs.mkdirp(entry.path);
    else await fs.writeFile(entry.path, entry.data);
  }
  await fs.mkdirp(APP);
  await fs.writeFile(RESTORE_MARKER, snapshot.id);
  await fs.mkdirp(SEED_MARKER);
}

async function acknowledge(fs: Filesystem, index: WorkspaceIndexStore, snapshot: SourceSnapshot): Promise<void> {
  await fs.flush();
  await index.restored(snapshot.template, snapshot.id, Date.now());
}
