import { type DirNode, type Node, MemFS, adoptInodes, basename, dirname } from "./fs";

type Change = { path: string; node: Node | null };

function sameFile(before: Node | undefined, after: Node): boolean {
  if (before?.kind !== "file" || after.kind !== "file") return false;
  if (before.ino !== after.ino || before.mtime !== after.mtime || before.data.length !== after.data.length) return false;
  for (let i = 0; i < before.data.length; i++) {
    if (before.data[i] !== after.data[i]) return false;
  }
  return true;
}

function changes(before: DirNode, after: DirNode, path: string, out: Change[]): void {
  for (const name of before.children.keys()) {
    if (!after.children.has(name)) out.push({ path: `${path}/${name}`, node: null });
  }
  for (const [name, node] of after.children) {
    const previous = before.children.get(name);
    const childPath = `${path}/${name}`;
    if (node.kind === "dir" && previous?.kind === "dir") changes(previous, node, childPath, out);
    else if (!sameFile(previous, node)) out.push({ path: childPath, node });
  }
}

/** Child changes only; a parent write to another path survives the child's exit. */
export function filesystemChanges(before: DirNode, after: DirNode): string {
  const out: Change[] = [];
  changes(before, after, "", out);
  return JSON.stringify(out, (_key, value: unknown) => {
    if (value instanceof Uint8Array) return { bytes: Array.from(value) };
    if (value instanceof Map) return { entries: Array.from(value) };
    return value;
  });
}

export function mergeFilesystemChanges(fs: MemFS, snapshot: string): void {
  const changes: Change[] = JSON.parse(snapshot, (_key, value) => {
    if (value && Array.isArray(value.bytes)) return new Uint8Array(value.bytes);
    if (value && Array.isArray(value.entries)) return new Map(value.entries);
    return value;
  });
  for (const { path, node } of changes) {
    const parent = fs.lookup(dirname(path));
    if (parent?.kind !== "dir") continue;
    if (node === null) parent.children.delete(basename(path));
    else {
      const current = parent.children.get(basename(path));
      if (current?.kind === "file" && node.kind === "file" && current.ino === node.ino) Object.assign(current, node);
      else parent.children.set(basename(path), node);
    }
  }
  adoptInodes(fs.root);
}

export function filesystemSync(fs: MemFS, initialRoot: DirNode = structuredClone(fs.root)) {
  const baseline = new MemFS(initialRoot);
  return {
    capture() {
      const snapshot = filesystemChanges(baseline.root, fs.root);
      return snapshot === "[]" ? "" : snapshot;
    },
    commit: (snapshot: string) => mergeFilesystemChanges(baseline, snapshot),
    merge(snapshot: string) {
      mergeFilesystemChanges(fs, snapshot);
      mergeFilesystemChanges(baseline, snapshot);
    },
  };
}
