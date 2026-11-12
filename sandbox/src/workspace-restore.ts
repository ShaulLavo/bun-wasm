import type { Runtime } from "waffle";
import type { WorkspaceIndexStore } from "./workspace-index";
import { APP, RESTORE_MARKER, SEED_MARKER, type SourceSnapshot } from "./workspace-source";

type Filesystem = Pick<Runtime["filesystem"], "lookup" | "remove" | "mkdirp" | "writeFile" | "readFile" | "flush">;

/** Caller serializes restore and explicit reset with the origin sandbox operation. */
export async function restoreSource(fs: Filesystem, index: WorkspaceIndexStore, template: string): Promise<void> {
  const snapshot = await index.source(template);
  if (!snapshot) return;
  if (await fs.lookup(SEED_MARKER)) {
    const restoredId = await fs.readFile(RESTORE_MARKER);
    if (restoredId && new TextDecoder().decode(restoredId) === snapshot.id) await acknowledge(fs, index, snapshot);
    return;
  }
  await replaceTree(fs, snapshot);
  await acknowledge(fs, index, snapshot);
}

async function replaceTree(fs: Filesystem, snapshot: SourceSnapshot): Promise<void> {
  const root = await fs.lookup("/");
  if (root?.kind !== "dir") throw new Error("Cannot restore source without a filesystem root");
  for (const name of root.children.keys()) await fs.remove(`/${name}`);
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
